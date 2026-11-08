/**
 * FluidNC WebSocket, one-line command queue, G-code streaming, SD upload, and file listing.
 * No DOM and no planner state.
 */

import { nameKey } from './gcode.ts'

export type MachineStatus = {
  connected: boolean
  state: string
  pos: [number, number] | null
  sd: string | null
}

export type BoardFile = { name: string; size: number }

export type UploadResult =
  | { kind: 'verified'; name: string; size: number }
  | { kind: 'unverified'; name: string; size: number; httpOk: boolean; detail: string }
  | { kind: 'missing'; name: string; httpOk: boolean; detail: string; listing: BoardFile[]; onFlash: boolean }
  | { kind: 'incomplete'; name: string; got: number; size: number }
  | { kind: 'bad-address' }

export type RunResult = { ok: true; lines: number } | { ok: false; reason: string }

export type FluidEvent =
  | { type: 'status'; status: MachineStatus }
  | { type: 'disconnected' }
  | { type: 'machine-error'; text: string }
  | { type: 'run-progress'; done: number; total: number }
  | { type: 'run-paused' }
  | { type: 'run-resumed' }

type QueueItem = { line: string; resolve: (ok: boolean) => void }

type RunState = {
  total: number
  done: number
  paused: boolean
  approachLines: number
  lines: string[]
  index: number
  flight: number
  resolveSeg: ((ok: boolean) => void) | null
  resolvePause: ((ok: boolean) => void) | null
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

function openSocket(url: string, protocol?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url)
    } catch {
      reject(new Error('open'))
      return
    }
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('timeout'))
    }, 2500)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      clearTimeout(timer)
      ws.onerror = null
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      ws.close()
      reject(new Error('error'))
    }
  })
}

export function boardURL(address: string): URL {
  const v = address.trim()
  return new URL(/:\/\//.test(v) ? v : 'http://' + v)
}

function httpDetail(status: number | undefined, err: string | undefined): string {
  if (err) return err
  if (status) return 'HTTP ' + status
  return ''
}

type TauriFetch = (url: string, init: { method: string; body: FormData }) => Promise<{ ok: boolean; status: number }>

function tauriFetch(): TauriFetch | undefined {
  const host = globalThis as { __TAURI__?: { http?: { fetch?: TauriFetch } } }
  return host.__TAURI__?.http?.fetch
}

async function postUpload(url: string, body: FormData): Promise<{ ok: boolean; status?: number; err?: string }> {
  const viaTauri = tauriFetch()
  if (viaTauri) {
    try {
      const response = await viaTauri(url, { method: 'POST', body })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      return { ok: false, err: String(error instanceof Error ? error.message : error) }
    }
  }
  try {
    await fetch(url, { method: 'POST', body, mode: 'no-cors' })
    return { ok: true }
  } catch (error) {
    return { ok: false, err: String(error instanceof Error ? error.message : error) }
  }
}

export class FluidNC {
  status: MachineStatus = { connected: false, state: '-', pos: null, sd: null }
  private ws: WebSocket | null = null
  private wco: [number, number, number] = [0, 0, 0]
  private queue: QueueItem[] = []
  private busy = false
  private waiter: ((ok: boolean) => void) | null = null
  private timer = 0
  private poll = 0
  private uploading = false
  private fileCapture: BoardFile[] | null = null
  private lastSdList: BoardFile[] = []
  private listChain: Promise<unknown> = Promise.resolve()
  private statusWaiters: (() => void)[] = []
  private run: RunState | null = null
  private abortReason = ''
  private sdTouchedAt = 0
  private connecting = false
  private listeners = new Set<(event: FluidEvent) => void>()

  subscribe(fn: (event: FluidEvent) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  get running(): boolean {
    return this.run != null
  }

  get uploadingNow(): boolean {
    return this.uploading
  }

  get runInfo(): { paused: boolean; done: number; approachLines: number } | null {
    if (!this.run) return null
    return { paused: this.run.paused, done: this.run.done, approachLines: this.run.approachLines }
  }

  sdBusy(now = Date.now()): boolean {
    return this.status.sd != null || now - this.sdTouchedAt < 1500
  }

  touchSd(now = Date.now()) {
    this.sdTouchedAt = now
  }

  /** Connect, or drop the socket if one is already open. Returns an error string, or null. */
  async connect(address: string): Promise<string | null> {
    if (this.ws) {
      this.ws.close()
      return null
    }
    if (this.connecting) return null
    this.connecting = true
    try {
      return await this.open(address)
    } finally {
      this.connecting = false
    }
  }

  private async open(address: string): Promise<string | null> {
    let url: URL
    try {
      url = boardURL(address)
    } catch {
      return 'Invalid address'
    }
    const port = Number(url.port) || 80
    const host = url.hostname
    const attempts: [string, string | undefined][] = [
      [`ws://${host}:${port}/`, 'webui-v3'],
      [`ws://${host}:${port + 1}/`, undefined],
      [`ws://${host}:${port + 2}/`, 'webui-v3'],
      [`ws://${host}:${port}/ws`, undefined],
    ]
    let ws: WebSocket | null = null
    const tried: string[] = []
    for (const [target, protocol] of attempts) {
      tried.push(target)
      try {
        ws = await openSocket(target, protocol)
        break
      } catch {
        /* try the next FluidNC port / protocol */
      }
    }
    if (!ws) {
      return 'Could not reach FluidNC (tried ' + tried.join(', ') + '). Check power/WiFi, close other tabs connected to the board, and open this file from disk (not the hosted link).'
    }
    this.ws = ws
    ws.onmessage = event => { this.onMessage(event.data) }
    ws.onclose = () => { this.onClose() }
    this.status = { ...this.status, connected: true }
    this.poll = globalThis.setInterval(() => {
      if (this.connected && !this.uploading) this.ws?.send('?')
    }, 250)
    void this.send('G21 G90')
    this.emitStatus()
    return null
  }

  disconnect() {
    this.ws?.close()
  }

  send(line: string): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false)
    return new Promise(resolve => {
      this.queue.push({ line, resolve })
      this.pump()
    })
  }

  /** Jog, dropping the command when the queue is already long. Feed slows down for short steps. */
  jog(vx: number, vy: number, mm: number) {
    if (!this.connected || this.queue.length > 3) return
    const feed = mm <= 0.6 ? 500 : 1500
    void this.send(`$J=G21 G91 X${(vx * mm).toFixed(3)} Y${(vy * mm).toFixed(3)} F${feed}`)
  }

  stop() {
    if (!this.connected || !this.ws) return
    if (this.run) this.endRun('Run stopped')
    this.failQueue()
    this.ws.send('!')
    const socket = this.ws
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('\x18')
    }, 200)
  }

  unlock(): Promise<boolean> {
    return this.send('$X')
  }

  home(command: '$H' | '$HX' | '$HY'): Promise<boolean> {
    return this.send(command)
  }

  async settle(): Promise<boolean> {
    await sleep(80)
    for (let i = 0; i < 200; i++) {
      await Promise.race([this.requestStatus(), sleep(500)])
      if (/^Idle/.test(this.status.state) && !this.queue.length && !this.busy) return true
      await sleep(80)
    }
    return false
  }

  async list(kind: 'SD' | 'LocalFS'): Promise<BoardFile[] | null> {
    const run = this.listChain.then(() => this.listNow(kind))
    this.listChain = run.then(() => undefined, () => undefined)
    return run
  }

  async fileSize(name: string): Promise<number | null> {
    const files = await this.list('SD')
    if (!files) return null
    const hit = files.find(file => nameKey(file.name) === nameKey(name))
    return hit ? hit.size : -1
  }

  /**
   * Multipart POST the way FluidNC expects it. A no-cors request skips the preflight the board cannot answer.
   * The SD listing is the verification, because that response body is often unreadable.
   */
  async uploadAndVerify(address: string, name: string, text: string, onTick?: (seconds: number) => void): Promise<UploadResult> {
    let origin: string
    try {
      origin = boardURL(address).origin
    } catch {
      return { kind: 'bad-address' }
    }
    const blob = new Blob([text], { type: 'text/plain' })
    const size = blob.size
    const body = new FormData()
    body.append('path', '/')
    body.append(name + 'S', String(size))
    body.append('myfile', blob, name)
    this.uploading = true
    const started = Date.now()
    const tick = setInterval(() => { onTick?.(Math.round((Date.now() - started) / 1000)) }, 400)
    let http: { ok: boolean; status?: number; err?: string }
    try {
      http = await postUpload(origin + '/upload', body)
    } finally {
      clearInterval(tick)
      this.uploading = false
    }
    let got: number | null = null
    if (this.connected) {
      await sleep(700)
      got = await this.fileSize(name)
      if (got !== size) {
        await sleep(2000)
        got = await this.fileSize(name)
      }
    }
    const detail = httpDetail(http.status, http.err)
    if (got === size) return { kind: 'verified', name, size }
    if (got == null) return { kind: 'unverified', name, size, httpOk: http.ok, detail }
    if (got < 0) {
      const listing = this.lastSdList.slice()
      const flash = await this.list('LocalFS')
      const onFlash = !!flash?.some(file => nameKey(file.name) === nameKey(name))
      return { kind: 'missing', name, httpOk: http.ok, detail, listing, onFlash }
    }
    return { kind: 'incomplete', name, got, size }
  }

  runFile(path: string) {
    if (!this.connected || !this.ws) return
    this.touchSd()
    this.ws.send('$SD/Run=' + path + '\n')
  }

  deleteFile(path: string): Promise<boolean> {
    return this.send('$SD/Delete=' + path)
  }

  resumeHold() {
    if (this.connected) this.ws?.send('~')
  }

  async runGcode(approach: string[], rest: string[]): Promise<RunResult> {
    if (this.run) return { ok: false, reason: 'already running' }
    this.abortReason = ''
    this.run = {
      total: approach.length + rest.length,
      done: 0,
      paused: false,
      approachLines: approach.length,
      lines: [],
      index: 0,
      flight: 0,
      resolveSeg: null,
      resolvePause: null,
    }
    if (!await this.runSeg(approach)) return { ok: false, reason: this.abortReason || 'Run aborted' }
    await this.settle()
    if (!this.run) return { ok: false, reason: this.abortReason || 'Run aborted' }
    this.run.paused = true
    this.emit({ type: 'run-paused' })
    const goOn = await new Promise<boolean>(resolve => {
      if (this.run) this.run.resolvePause = resolve
      else resolve(false)
    })
    if (!goOn || !this.run) return { ok: false, reason: this.abortReason || 'Run aborted' }
    this.run.paused = false
    this.run.resolvePause = null
    this.emit({ type: 'run-resumed' })
    if (!await this.runSeg(rest)) return { ok: false, reason: this.abortReason || 'Run aborted' }
    await this.settle()
    if (!this.run) return { ok: false, reason: this.abortReason || 'Run aborted' }
    const lines = this.run.total
    this.run = null
    return { ok: true, lines }
  }

  resumeRun() {
    const run = this.run
    if (!run?.resolvePause) return
    const resolve = run.resolvePause
    run.resolvePause = null
    resolve(true)
  }

  private emit(event: FluidEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private emitStatus() {
    const status = this.status
    this.emit({
      type: 'status',
      status: {
        connected: status.connected,
        state: status.state,
        pos: status.pos ? [status.pos[0], status.pos[1]] : null,
        sd: status.sd,
      },
    })
  }

  private onClose() {
    const duringRun = this.run != null
    this.ws = null
    clearInterval(this.poll)
    this.status = { connected: false, state: '-', pos: null, sd: null }
    if (duringRun) this.endRun('Run aborted: connection lost')
    this.failQueue()
    this.flushStatus()
    this.emitStatus()
    this.emit({ type: 'disconnected' })
  }

  private failQueue() {
    clearTimeout(this.timer)
    const pending = this.queue
    this.queue = []
    this.busy = false
    const waiter = this.waiter
    this.waiter = null
    waiter?.(false)
    for (const item of pending) item.resolve(false)
  }

  private pump() {
    if (this.busy || !this.queue.length || !this.connected || !this.ws) return
    this.busy = true
    const item = this.queue.shift()!
    this.waiter = item.resolve
    this.ws.send(item.line + '\n')
    this.timer = globalThis.setTimeout(() => { this.finishQueue(true) }, 120000)
  }

  private finishQueue(err: boolean) {
    if (!this.busy) return
    clearTimeout(this.timer)
    this.busy = false
    const waiter = this.waiter
    this.waiter = null
    waiter?.(!err)
    this.pump()
  }

  private requestStatus(): Promise<void> {
    return new Promise(resolve => {
      this.statusWaiters.push(resolve)
      if (this.connected) this.ws?.send('?')
    })
  }

  private flushStatus() {
    const waiters = this.statusWaiters
    this.statusWaiters = []
    for (const waiter of waiters) waiter()
  }

  private onMessage(data: unknown) {
    const text = typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : null
    if (text == null) return
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      const status = /^<([^|>]+)\|(.*?)>?$/.exec(line)
      if (status) {
        this.onStatus(status[1], status[2])
        continue
      }
      const file = /^\[FILE:\s*(.+?)\s*\|\s*SIZE:\s*(\d+)/.exec(line)
      if (file) {
        this.fileCapture?.push({ name: file[1], size: Number(file[2]) })
        continue
      }
      if (/^ok/.test(line)) {
        if (this.run) this.onRunOk()
        else this.finishQueue(false)
        continue
      }
      if (/^error/.test(line)) {
        this.emit({ type: 'machine-error', text: 'FluidNC: ' + line })
        if (this.run) this.endRun('Run aborted: ' + line)
        else this.finishQueue(true)
        continue
      }
      if (/^ALARM/.test(line) || /^\[MSG:.*(alarm|Alarm)/.test(line)) {
        this.emit({ type: 'machine-error', text: line + ' (use Unlock after checking)' })
        if (this.run) this.endRun('Run aborted: ' + line)
      }
    }
  }

  private onStatus(state: string, body: string) {
    const fields: Record<string, string> = {}
    for (const part of body.split('|')) {
      const colon = part.indexOf(':')
      if (colon < 0) fields[part] = ''
      else fields[part.slice(0, colon)] = part.slice(colon + 1)
    }
    if (fields.WCO) {
      const wco = fields.WCO.split(',').map(Number)
      if (wco.length >= 3) this.wco = [wco[0], wco[1], wco[2]]
    }
    const raw = (fields.MPos || fields.WPos || '').split(',').map(Number)
    if (raw.length < 2 || raw.some(value => Number.isNaN(value))) return
    const origin = fields.MPos ? [0, 0, 0] : this.wco
    const pos: [number, number] = [raw[0] + origin[0], raw[1] + origin[1]]
    this.status = { connected: true, state, pos, sd: fields.SD ?? null }
    this.emitStatus()
    this.flushStatus()
    if (this.run && !this.run.paused && /^(Alarm|Door)/i.test(state)) {
      this.endRun('Run aborted: controller state ' + state)
    }
  }

  private async listNow(kind: 'SD' | 'LocalFS'): Promise<BoardFile[] | null> {
    if (!this.connected) return null
    const captured: BoardFile[] = []
    this.fileCapture = captured
    const ok = await this.send('$' + kind + '/List')
    if (this.fileCapture === captured) this.fileCapture = null
    if (kind === 'SD') this.lastSdList = captured
    return ok ? captured : null
  }

  private endRun(reason: string) {
    const run = this.run
    if (!run) return
    this.run = null
    this.abortReason = reason
    const seg = run.resolveSeg
    const pause = run.resolvePause
    run.resolveSeg = null
    run.resolvePause = null
    seg?.(false)
    pause?.(false)
  }

  private runSeg(lines: string[]): Promise<boolean> {
    return new Promise(resolve => {
      const run = this.run
      if (!run) {
        resolve(false)
        return
      }
      run.lines = lines
      run.index = 0
      run.flight = 0
      run.resolveSeg = resolve
      if (!lines.length) {
        run.resolveSeg = null
        resolve(true)
        return
      }
      this.pumpRun()
    })
  }

  private pumpRun() {
    const run = this.run
    if (!run || run.paused || !this.ws) return
    while (run.index < run.lines.length && run.flight < 8 && this.connected) {
      this.ws.send(run.lines[run.index++] + '\n')
      run.flight++
    }
  }

  private onRunOk() {
    const run = this.run
    if (!run?.resolveSeg) return
    run.flight--
    run.done++
    if (run.done % 40 === 0 || run.done === run.total) {
      this.emit({ type: 'run-progress', done: run.done, total: run.total })
    }
    if (run.index >= run.lines.length && run.flight <= 0) {
      const resolve = run.resolveSeg
      run.resolveSeg = null
      resolve(true)
    } else this.pumpRun()
  }
}
