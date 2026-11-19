#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod remote;

#[cfg(any(target_os = "android", target_os = "ios"))]
mod remote {
    use serde::Serialize;
    use tauri::AppHandle;

    #[derive(Default)]
    pub struct RemoteHub;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RemoteAccessInfo {
        pub port: u16,
        pub address: String,
    }

    pub fn install_event_bridge(_: &AppHandle) {}

    #[tauri::command]
    pub async fn start_remote_access() -> Result<RemoteAccessInfo, String> {
        Err("Remote access is available in the Filum desktop app only.".to_owned())
    }

    #[tauri::command]
    pub async fn stop_remote_access() -> Result<(), String> {
        Err("Remote access is available in the Filum desktop app only.".to_owned())
    }

    #[tauri::command]
    pub fn get_remote_access() -> Result<Option<RemoteAccessInfo>, String> {
        Ok(None)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(remote::RemoteHub::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            remote::install_event_bridge(app.handle());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            remote::start_remote_access,
            remote::stop_remote_access,
            remote::get_remote_access,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
