use std::{
    collections::HashMap,
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, broadcast, oneshot},
    task::JoinHandle,
};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

const REMOTE_PORT: u16 = 8080;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessInfo {
    pub port: u16,
    pub address: String,
}

struct RunningServer {
    info: RemoteAccessInfo,
    shutdown: oneshot::Sender<()>,
    clients_shutdown: broadcast::Sender<()>,
    task: JoinHandle<()>,
}

pub struct RemoteHub {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    events: broadcast::Sender<String>,
    server: AsyncMutex<Option<RunningServer>>,
}

impl Default for RemoteHub {
    fn default() -> Self {
        let (events, _) = broadcast::channel(128);
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            events,
            server: AsyncMutex::new(None),
        }
    }
}

#[derive(Clone)]
struct ServerState {
    host: String,
    app: AppHandle,
    hub: RemoteBridge,
    clients_shutdown: broadcast::Sender<()>,
    clients: Arc<Semaphore>,
    rpc_slots: Arc<Semaphore>,
}

#[derive(Clone)]
struct RemoteBridge {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    events: broadcast::Sender<String>,
}

#[derive(Deserialize)]
struct RemoteResponse {
    id: String,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct RemoteRequest {
    id: String,
    method: String,
    #[serde(default)]
    args: Value,
}

#[derive(Clone, Serialize)]
struct ServerRequest<'a> {
    r#type: &'static str,
    id: &'a str,
    method: &'a str,
    args: &'a Value,
}

#[derive(Serialize)]
struct ServerResult {
    r#type: &'static str,
    id: String,
    result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn install_event_bridge(app: &AppHandle) {
    let hub = app.state::<RemoteHub>();
    let pending = Arc::clone(&hub.pending);
    app.listen("remote-response", move |event| {
        let response = match serde_json::from_str::<RemoteResponse>(event.payload()) {
            Ok(response) => response,
            Err(error) => {
                log::warn!("Ignoring malformed remote response: {error}");
                return;
            }
        };
        let result = if let Some(error) = response.error {
            Err(error)
        } else {
            Ok(response.result)
        };
        if let Ok(mut requests) = pending.lock() {
            if let Some(sender) = requests.remove(&response.id) {
                let _ = sender.send(result);
            }
        }
    });

    let events = hub.events.clone();
    app.listen("remote-event", move |event| {
        let _ = events.send(event.payload().to_owned());
    });
}

#[tauri::command]
pub async fn start_remote_access(
    app: AppHandle,
    hub: tauri::State<'_, RemoteHub>,
) -> Result<RemoteAccessInfo, String> {
    let mut server = hub.server.lock().await;
    if let Some(running) = server.as_ref() {
        return Ok(running.info.clone());
    }

    let local_address = local_network_address()?;
    let ui_dir = ui_directory(&app)?;
    let index = ui_dir.join("index.html");
    if !index.is_file() {
        return Err(format!(
            "The remote UI is missing at {}. Rebuild Filum and try again.",
            index.display()
        ));
    }

    let listener = match TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], REMOTE_PORT))).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            log::warn!(
                "Remote access port {REMOTE_PORT} is occupied; selecting an available port."
            );
            TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
                .await
                .map_err(|fallback| format!("Could not start the remote server on port {REMOTE_PORT} or an available fallback port: {fallback}"))?
        }
        Err(error) => {
            return Err(format!(
                "Could not start the remote server on port {REMOTE_PORT}: {error}"
            ));
        }
    };
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the remote server port: {error}"))?
        .port();
    let host = format!("{local_address}:{port}");
    let (shutdown, shutdown_rx) = oneshot::channel();
    let (clients_shutdown, _) = broadcast::channel(8);
    let state = ServerState {
        host,
        app,
        hub: RemoteBridge {
            pending: Arc::clone(&hub.pending),
            events: hub.events.clone(),
        },
        clients_shutdown: clients_shutdown.clone(),
        clients: Arc::new(Semaphore::new(4)),
        rpc_slots: Arc::new(Semaphore::new(8)),
    };
    let index_file = ServeFile::new(index);
    let service = ServeDir::new(ui_dir)
        .append_index_html_on_directories(true)
        .not_found_service(index_file);
    let router = axum::Router::new()
        .route("/control", axum::routing::get(control_socket))
        .route(
            "/",
            axum::routing::get(|| async {
                axum::response::Redirect::temporary("/index.html?remote=1")
            }),
        )
        .fallback_service(service)
        .with_state(state);
    let task = tokio::spawn(async move {
        let result = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await;
        if let Err(error) = result {
            log::error!("Filum remote server stopped unexpectedly: {error}");
        }
    });
    let info = RemoteAccessInfo {
        port,
        address: local_address.to_string(),
    };
    *server = Some(RunningServer {
        info: info.clone(),
        shutdown,
        clients_shutdown,
        task,
    });
    Ok(info)
}

#[tauri::command]
pub async fn stop_remote_access(hub: tauri::State<'_, RemoteHub>) -> Result<(), String> {
    stop_server(&hub).await
}

#[tauri::command]
pub async fn get_remote_access(
    hub: tauri::State<'_, RemoteHub>,
) -> Result<Option<RemoteAccessInfo>, String> {
    let server = hub.server.lock().await;
    Ok(server.as_ref().map(|running| running.info.clone()))
}

async fn stop_server(hub: &RemoteHub) -> Result<(), String> {
    let running = hub.server.lock().await.take();
    if let Some(running) = running {
        let _ = running.clients_shutdown.send(());
        let _ = running.shutdown.send(());
        let mut task = running.task;
        if tokio::time::timeout(Duration::from_secs(2), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
            return Err("The remote server did not stop in time.".to_owned());
        }
        task.await
            .map_err(|error| format!("The remote server task failed: {error}"))?;
    }
    Ok(())
}

fn local_network_address() -> Result<IpAddr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Could not determine the laptop's network address: {error}"))?;
    socket
        .connect((Ipv4Addr::new(192, 0, 2, 1), 9))
        .map_err(|error| format!("Could not determine the laptop's network address: {error}"))?;
    let address = socket
        .local_addr()
        .map_err(|error| format!("Could not determine the laptop's network address: {error}"))?
        .ip();
    if address.is_loopback() || address.is_unspecified() {
        return Err(
            "Connect the laptop to Wi-Fi or a wired network before enabling remote access."
                .to_owned(),
        );
    }
    Ok(address)
}

fn ui_directory(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        if development.is_dir() {
            return Ok(development);
        }
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not locate Filum's bundled resources: {error}"))?;
    let bundled = resources.join("remote-ui");
    if bundled.is_dir() {
        return Ok(bundled);
    }
    Err("Filum's remote UI is not installed. Rebuild the desktop app and try again.".to_owned())
}

fn is_private_lan_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_private() || address.is_loopback(),
        IpAddr::V6(address) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
    }
}

async fn control_socket(
    ws: axum::extract::ws::WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<ServerState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> Result<impl axum::response::IntoResponse, axum::http::StatusCode> {
    use axum::http::header::{HOST, ORIGIN};

    if !is_private_lan_address(peer.ip()) {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }
    let host = headers.get(HOST).and_then(|value| value.to_str().ok());
    let origin = headers.get(ORIGIN).and_then(|value| value.to_str().ok());
    if !matches!((host, origin), (Some(host), Some(origin)) if host == state.host && origin == format!("http://{}", state.host))
    {
        return Err(axum::http::StatusCode::FORBIDDEN);
    }
    let client_permit = state
        .clients
        .clone()
        .try_acquire_owned()
        .map_err(|_| axum::http::StatusCode::TOO_MANY_REQUESTS)?;
    Ok(ws
        .max_message_size(32 * 1024 * 1024)
        .max_frame_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state, client_permit)))
}

async fn handle_socket(
    socket: axum::extract::ws::WebSocket,
    state: ServerState,
    _client_permit: OwnedSemaphorePermit,
) {
    use axum::extract::ws::Message;
    use futures_util::{SinkExt, StreamExt};
    use tokio::sync::mpsc;

    let (mut socket_tx, mut socket_rx) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();
    let mut events = state.hub.events.subscribe();
    let mut shutdown = state.clients_shutdown.subscribe();

    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                message = outbound_rx.recv() => {
                    let Some(message) = message else { break };
                    if socket_tx.send(message).await.is_err() { break; }
                }
                event = events.recv() => {
                    match event {
                        Ok(text) => {
                            if socket_tx.send(Message::Text(text.into())).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = shutdown.recv() => {
                    let _ = socket_tx.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    while let Some(Ok(message)) = socket_rx.next().await {
        match message {
            Message::Text(text) => {
                let request = match serde_json::from_str::<RemoteRequest>(&text) {
                    Ok(request) if allowed_remote_method(&request.method) => request,
                    Ok(_) => {
                        let _ = outbound_tx.send(Message::Text(
                            r#"{"type":"error","message":"Unsupported remote operation."}"#.into(),
                        ));
                        continue;
                    }
                    Err(error) => {
                        log::warn!("Ignoring malformed remote request: {error}");
                        continue;
                    }
                };
                let request_permit = match state.rpc_slots.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let response = ServerResult {
                            r#type: "result",
                            id: request.id,
                            result: Value::Null,
                            error: Some("Too many remote operations are in progress.".to_owned()),
                        };
                        if let Ok(text) = serde_json::to_string(&response) {
                            let _ = outbound_tx.send(Message::Text(text.into()));
                        }
                        continue;
                    }
                };
                let app = state.app.clone();
                let pending = Arc::clone(&state.hub.pending);
                let outbound = outbound_tx.clone();
                tokio::spawn(async move {
                    let _request_permit = request_permit;
                    let id = Uuid::new_v4().simple().to_string();
                    let (reply_tx, reply_rx) = oneshot::channel();
                    if let Ok(mut requests) = pending.lock() {
                        requests.insert(id.clone(), reply_tx);
                    } else {
                        return;
                    }
                    let payload = ServerRequest {
                        r#type: "request",
                        id: &id,
                        method: &request.method,
                        args: &request.args,
                    };
                    if let Err(error) = app.emit("remote-request", payload) {
                        if let Ok(mut requests) = pending.lock() {
                            requests.remove(&id);
                        }
                        log::error!("Could not dispatch a remote operation: {error}");
                        return;
                    }
                    let result =
                        tokio::time::timeout(Duration::from_secs(24 * 60 * 60), reply_rx).await;
                    let (value, error) = match result {
                        Ok(Ok(Ok(value))) => (value, None),
                        Ok(Ok(Err(error))) => (Value::Null, Some(error)),
                        Ok(Err(_)) => (
                            Value::Null,
                            Some("The desktop closed the remote request.".to_owned()),
                        ),
                        Err(_) => (
                            Value::Null,
                            Some("The remote operation timed out.".to_owned()),
                        ),
                    };
                    if let Ok(mut requests) = pending.lock() {
                        requests.remove(&id);
                    }
                    let response = ServerResult {
                        r#type: "result",
                        id: request.id,
                        result: value,
                        error,
                    };
                    if let Ok(text) = serde_json::to_string(&response) {
                        let _ = outbound.send(Message::Text(text.into()));
                    }
                });
            }
            Message::Ping(payload) => {
                let _ = outbound_tx.send(Message::Pong(payload));
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    drop(outbound_tx);
    let _ = writer.await;
}

fn allowed_remote_method(method: &str) -> bool {
    matches!(
        method,
        "snapshot"
            | "send"
            | "jog"
            | "stop"
            | "pauseMotion"
            | "unlock"
            | "home"
            | "settle"
            | "list"
            | "fileSize"
            | "uploadAndVerify"
            | "runFile"
            | "deleteFile"
            | "resumeHold"
            | "runGcode"
            | "resumeRun"
            | "pauseRun"
            | "sdBusy"
            | "setPlannerState"
    )
}
