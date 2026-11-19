import type {
  BoardFile,
  FluidEvent,
  MachineStatus,
  RunResult,
  UploadResult,
} from '../lib/fluidnc.ts'
import type { Anchor, Measurements, RawParams } from '../lib/planner.ts'

type RemoteSnapshot = {
  status: MachineStatus
  running: boolean
  runInfo: { paused: boolean; done: number; approachLines: number } | null
  sdBusy: boolean
  plannerState: PlannerSyncState
}

export type PlannerSyncState = {
  raw: RawParams
  anchors: Anchor[]
  anchorAuto: boolean
  sequence: string
  measurements: Measurements
  address: string
  fileName: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: number
}

export function isRemoteMode(): boolean {
  return new URLSearchParams(window.location.search).get('remote') === '1'
}

function isFluidEvent(value: unknown): value is FluidEvent {
  if (value == null || typeof value !== 'object' || !('type' in value)) return false
  const type = value.type
  return type === 'planner-state' || type === 'status' || type === 'disconnected' || type === 'machine-error' ||
    type === 'run-progress' || type === 'run-paused' || type === 'run-resumed'
}

export class RemoteFluidNC {
  status: MachineStatus = { connected: false, state: '-', pos: null, sd: null }
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private nextId = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(event: FluidEvent) => void>()
  private activeRun = false
  private activeRunInfo: RemoteSnapshot['runInfo'] = null
  private boardBusy = false
  private lastPlannerState = ''
  private uploadCallbacks = new Set<(seconds: number) => void>()

  constructor() {
    if (isRemoteMode()) {
      window.setTimeout(() => {
        void this.ensureSocket().catch(error => this.emitError(error))
      }, 0)
    }
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.status.connected
  }

  get serverConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  get running(): boolean {
    return this.activeRun
  }

  get uploadingNow(): boolean {
    return false
  }

  get runInfo(): RemoteSnapshot['runInfo'] {
    return this.activeRunInfo
  }

  get plannerReady(): boolean {
    return this.lastPlannerState !== ''
  }

  subscribe(fn: (event: FluidEvent) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  sdBusy(): boolean {
    return this.boardBusy || this.status.sd != null
  }

  async send(line: string): Promise<boolean> {
    return this.request<boolean>('send', [line])
  }

  async jog(vx: number, vy: number, mm: number): Promise<void> {
    await this.request<void>('jog', [vx, vy, mm])
  }

  async stop(): Promise<void> {
    await this.request<void>('stop')
  }

  async pauseMotion(): Promise<void> {
    await this.request<void>('pauseMotion')
  }

  async unlock(): Promise<boolean> {
    return this.request<boolean>('unlock')
  }

  async home(command: '$H' | '$HX' | '$HY'): Promise<boolean> {
    return this.request<boolean>('home', [command])
  }

  async settle(): Promise<boolean> {
    return this.request<boolean>('settle')
  }

  async list(kind: 'SD' | 'LocalFS'): Promise<BoardFile[] | null> {
    return this.request<BoardFile[] | null>('list', [kind])
  }

  async fileSize(name: string): Promise<number | null> {
    return this.request<number | null>('fileSize', [name])
  }

  async uploadAndVerify(
    address: string,
    name: string,
    text: string,
    onTick?: (seconds: number) => void,
  ): Promise<UploadResult> {
    if (onTick) this.uploadCallbacks.add(onTick)
    try {
      return await this.request<UploadResult>('uploadAndVerify', [address, name, text])
    } finally {
      if (onTick) this.uploadCallbacks.delete(onTick)
    }
  }

  async runFile(path: string): Promise<void> {
    await this.request<void>('runFile', [path])
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.request<boolean>('deleteFile', [path])
  }

  async resumeHold(): Promise<void> {
    await this.request<void>('resumeHold')
  }

  async runGcode(approach: string[], rest: string[]): Promise<RunResult> {
    this.activeRun = true
    try {
      return await this.request<RunResult>('runGcode', [approach, rest])
    } finally {
      this.activeRun = false
      this.activeRunInfo = null
    }
  }

  async resumeRun(): Promise<void> {
    await this.request<void>('resumeRun')
  }

  async pauseRun(): Promise<void> {
    await this.request<void>('pauseRun')
  }

  async syncPlannerState(state: PlannerSyncState): Promise<void> {
    const serialized = JSON.stringify(state)
    if (serialized === this.lastPlannerState) return
    this.lastPlannerState = serialized
    try {
      await this.request<void>('setPlannerState', [state])
    } catch (error) {
      this.lastPlannerState = ''
      throw error
    }
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.opening) return this.opening

    if (!isRemoteMode()) throw new Error('Open the remote access link provided by Filum on the laptop.')
    this.opening = new Promise<void>((resolve, reject) => {
      const url = new URL('/control', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url)
      const fail = (error: Error) => {
        if (this.socket === socket) this.socket = null
        reject(error)
      }
      socket.addEventListener('open', () => {
        this.socket = socket
        socket.addEventListener('message', event => this.receive(event.data))
        socket.addEventListener('close', () => this.socketClosed(socket))
        socket.addEventListener('error', () => this.socketClosed(socket))
        resolve()
      }, { once: true })
      socket.addEventListener('error', () => fail(new Error('Could not connect to Filum on the laptop. Check the Wi-Fi and remote access link.')), { once: true })
    }).then(async () => {
      const snapshot = await this.request<RemoteSnapshot>('snapshot')
      this.applySnapshot(snapshot)
    }).finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private socketClosed(socket: WebSocket) {
    if (this.socket !== socket) return
    this.socket = null
    this.status = { connected: false, state: '-', pos: null, sd: null }
    this.activeRun = false
    this.activeRunInfo = null
    this.boardBusy = false
    const reason = 'Lost the connection to Filum on the laptop. Reconnect to control the machine.'
    this.emit({ type: 'machine-error', text: reason })
    this.emit({ type: 'disconnected' })
    for (const [id, request] of this.pending) {
      window.clearTimeout(request.timeout)
      request.reject(new Error(reason))
      this.pending.delete(id)
    }
  }

  private request<T>(method: string, args: unknown[] = []): Promise<T> {
    return this.ensureSocket().then(() => new Promise<T>((resolve, reject) => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('The connection to Filum on the laptop is closed.'))
        return
      }
      const id = `${Date.now()}-${++this.nextId}`
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`The desktop did not respond to ${method}.`)
        this.emitError(error)
        reject(error)
      }, 24 * 60 * 60 * 1000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout })
      try {
        socket.send(JSON.stringify({ id, method, args }))
      } catch (error) {
        window.clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })).catch(error => {
      this.emitError(error)
      throw error
    })
  }

  private receive(data: unknown) {
    if (typeof data !== 'string') return
    let message: unknown
    try {
      message = JSON.parse(data) as unknown
    } catch (error) {
      console.warn('Ignoring malformed data from the Filum desktop.', error)
      return
    }
    if (message == null || typeof message !== 'object') return
    if ('type' in message && message.type === 'result' && 'id' in message && typeof message.id === 'string') {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      window.clearTimeout(request.timeout)
      if ('error' in message && typeof message.error === 'string') {
        const error = new Error(message.error)
        this.emitError(error)
        request.reject(error)
      } else {
        request.resolve('result' in message ? message.result : undefined)
      }
      return
    }
    if ('type' in message && message.type === 'error' && 'message' in message && typeof message.message === 'string') {
      this.emit({ type: 'machine-error', text: message.message })
      return
    }
    if (isFluidEvent(message)) {
      this.applyEvent(message)
      return
    }
    if ('type' in message && message.type === 'upload-tick' && 'seconds' in message && typeof message.seconds === 'number') {
      for (const callback of this.uploadCallbacks) callback(message.seconds)
    }
  }

  private applySnapshot(snapshot: RemoteSnapshot) {
    this.status = snapshot.status
    this.activeRun = snapshot.running
    this.activeRunInfo = snapshot.runInfo
    this.boardBusy = snapshot.sdBusy
    this.emit({ type: 'status', status: this.status })
    this.applyEvent({ type: 'planner-state', state: snapshot.plannerState })
  }

  private applyEvent(event: FluidEvent) {
    if (event.type === 'planner-state') {
      this.lastPlannerState = JSON.stringify(event.state)
      this.emit(event)
      return
    }
    if (event.type === 'status') this.status = event.status
    if (event.type === 'disconnected') {
      this.status = { connected: false, state: '-', pos: null, sd: null }
      this.activeRun = false
      this.activeRunInfo = null
    }
    if (event.type === 'run-progress') {
      this.activeRun = true
      this.activeRunInfo = {
        paused: false,
        done: event.done,
        approachLines: this.activeRunInfo?.approachLines ?? 0,
      }
    } else if (event.type === 'run-paused') {
      this.activeRunInfo = { paused: true, done: this.activeRunInfo?.done ?? 0, approachLines: this.activeRunInfo?.approachLines ?? 0 }
    } else if (event.type === 'run-resumed') {
      if (this.activeRunInfo) this.activeRunInfo = { ...this.activeRunInfo, paused: false }
    }
    this.boardBusy = this.status.sd != null
    this.emit(event)
  }

  private emitError(reason: unknown) {
    const text = reason instanceof Error ? reason.message : String(reason)
    this.emit({ type: 'machine-error', text })
  }

  private emit(event: FluidEvent) {
    for (const listener of this.listeners) listener(event)
  }
}
