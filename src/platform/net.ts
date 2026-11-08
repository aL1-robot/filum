import { isTauri } from './runtime.ts'

export type BoardSocket = {
  readonly readyState: number
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

export type BoardTransportKind = 'webview' | 'rust'

export interface BoardTransport {
  openSocket(url: string, protocol?: string): Promise<BoardSocket>
  postMultipart(url: string, body: FormData, timeoutMs: number): Promise<UploadResponse>
}

export function boardURL(address: string): URL {
  const value = address.trim()
  const url = new URL(/:\/\//.test(value) ? value : `http://${value}`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const octetText = host.split('.')
  const isIpv4 = octetText.length === 4 &&
    octetText.every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  const octets = isIpv4 ? octetText.map(Number) : []
  const isPrivateIpv4 = isIpv4 && (
    octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  )

  if (url.protocol !== 'http:' || !(isPrivateIpv4 || host === 'localhost' || host === '127.0.0.1' || host === '::1')) {
    throw new Error('Use an HTTP address on a private IPv4 network or localhost.')
  }
  return url
}

export function boardSocketAttempts(url: URL): [string, string | undefined][] {
  const port = Number(url.port) || 80
  const host = url.hostname
  return [
    [`ws://${host}:${port}/`, 'webui-v3'],
    [`ws://${host}:${port + 1}/`, undefined],
    [`ws://${host}:${port + 2}/`, 'webui-v3'],
    [`ws://${host}:${port}/ws`, undefined],
  ]
}

class TauriBoardSocket implements BoardSocket {
  private state: number = WebSocket.OPEN
  private removeListener: (() => void) | undefined
  private readonly socket: import('@tauri-apps/plugin-websocket').default
  onmessage: BoardSocket['onmessage'] = null
  onclose: BoardSocket['onclose'] = null
  onerror: BoardSocket['onerror'] = null

  constructor(socket: import('@tauri-apps/plugin-websocket').default) {
    this.socket = socket
    this.removeListener = socket.addListener(message => {
      if (message.type === 'Text') {
        this.onmessage?.({ data: message.data })
      } else if (message.type === 'Binary') {
        this.onmessage?.({ data: new Uint8Array(message.data).buffer })
      } else if (message.type === 'Close') {
        this.finishClose()
      }
    })
  }

  get readyState(): number {
    return this.state
  }

  send(data: string): void {
    void this.socket.send(data).catch(error => {
      console.error('FluidNC WebSocket send failed.', error)
      this.onerror?.()
      this.finishClose()
    })
  }

  close(): void {
    if (this.state !== WebSocket.OPEN) return
    this.state = WebSocket.CLOSING
    this.removeListener?.()
    this.removeListener = undefined
    void this.socket.disconnect().catch(error => {
      console.error('FluidNC WebSocket disconnect failed.', error)
    })
    this.finishClose()
  }

  private finishClose(): void {
    if (this.state === WebSocket.CLOSED) return
    this.state = WebSocket.CLOSED
    this.removeListener?.()
    this.removeListener = undefined
    this.onclose?.()
  }
}

class BrowserBoardSocket implements BoardSocket {
  private readonly socket: WebSocket
  onmessage: BoardSocket['onmessage'] = null
  onclose: BoardSocket['onclose'] = null
  onerror: BoardSocket['onerror'] = null

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = event => this.onmessage?.({ data: event.data })
    socket.onclose = () => this.onclose?.()
    socket.onerror = () => this.onerror?.()
  }

  get readyState(): number {
    return this.socket.readyState
  }

  send(data: string): void {
    this.socket.send(data)
  }

  close(): void {
    this.socket.close()
  }
}

function openBrowserSocket(url: string, protocol?: string): Promise<BoardSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket
    try {
      socket = protocol ? new WebSocket(url, protocol) : new WebSocket(url)
    } catch (error) {
      reject(error)
      return
    }

    const adapter = new BrowserBoardSocket(socket)
    socket.addEventListener('open', () => resolve(adapter), { once: true })
    socket.addEventListener('error', () => {
      if (socket.readyState !== WebSocket.OPEN) reject(new Error('WebSocket connection failed'))
    }, { once: true })
  })
}

async function openRawBoardSocket(
  url: string,
  protocol: string | undefined,
  transport: BoardTransportKind | undefined,
): Promise<BoardSocket> {
  if (transport === 'webview' || (!transport && !isTauri())) return openBrowserSocket(url, protocol)
  if (!isTauri()) throw new Error('The Rust-backed transport is only available in a Tauri app.')

  const { default: TauriWebSocket } = await import('@tauri-apps/plugin-websocket')
  const socket = await TauriWebSocket.connect(url, protocol
    ? { headers: { 'Sec-WebSocket-Protocol': protocol } }
    : undefined)
  return new TauriBoardSocket(socket)
}

export function openBoardSocket(
  url: string,
  protocol?: string,
  transport?: BoardTransportKind,
): Promise<BoardSocket> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = globalThis.setTimeout(() => {
      settled = true
      reject(new Error('WebSocket connection timed out'))
    }, 2500)

    void openRawBoardSocket(url, protocol, transport).then(socket => {
      if (settled) {
        socket.close()
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(socket)
    }).catch(error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

export type UploadResponse = { ok: boolean; status?: number; err?: string }

export async function postMultipart(
  url: string,
  body: FormData,
  timeoutMs: number,
  transport?: BoardTransportKind,
): Promise<UploadResponse> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (transport === 'rust' || (!transport && isTauri())) {
      if (!isTauri()) throw new Error('The Rust-backed transport is only available in a Tauri app.')
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
      const response = await tauriFetch(url, {
        method: 'POST',
        body,
        signal: controller.signal,
        connectTimeout: timeoutMs,
      })
      return { ok: response.ok, status: response.status }
    }

    try {
      const response = await fetch(url, { method: 'POST', body, mode: 'no-cors', signal: controller.signal })
      return response.type === 'opaque'
        ? { ok: true }
        : { ok: response.ok, status: response.status }
    } catch (error) {
      return { ok: false, err: String(error instanceof Error ? error.message : error) }
    }
  } catch (error) {
    return { ok: false, err: String(error instanceof Error ? error.message : error) }
  } finally {
    clearTimeout(timer)
  }
}

export function createBoardTransport(kind?: BoardTransportKind): BoardTransport {
  return {
    openSocket: (url, protocol) => openBoardSocket(url, protocol, kind),
    postMultipart: (url, body, timeoutMs) => postMultipart(url, body, timeoutMs, kind),
  }
}
