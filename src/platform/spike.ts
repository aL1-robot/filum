import {
  boardSocketAttempts,
  boardURL,
  createBoardTransport,
  type BoardTransportKind,
} from './net.ts'

type SpikeLog = (line: string) => void

function messageText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return null
}

function waitForLine(
  lines: string[],
  start: number,
  matches: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setInterval(() => {
      const line = lines.slice(start).find(matches)
      if (line) {
        clearInterval(timer)
        resolve(line)
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out after ${timeoutMs} ms`))
      }
    }, 50)
    const startedAt = Date.now()
  })
}

async function testTransport(address: string, transport: BoardTransportKind, log: SpikeLog) {
  const url = boardURL(address)
  const boardTransport = createBoardTransport(transport)
  let socket: Awaited<ReturnType<typeof boardTransport.openSocket>> | undefined

  try {
    for (const [endpoint, protocol] of boardSocketAttempts(url)) {
      log(`Connecting via ${transport}: ${endpoint}${protocol ? ` (${protocol})` : ''}`)
      try {
        socket = await boardTransport.openSocket(endpoint, protocol)
        break
      } catch (error) {
        log(`  connection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (!socket) throw new Error('All FluidNC WebSocket endpoints failed.')

    const lines: string[] = []
    socket.onmessage = event => {
      const text = messageText(event.data)
      if (text != null) lines.push(...text.split(/\r?\n/).filter(Boolean))
    }

    let start = lines.length
    socket.send('?')
    const status = await waitForLine(lines, start, line => /^<.+>$/.test(line), 10_000)
    log(`  status: ${status}`)

    start = lines.length
    socket.send('$SD/List\n')
    await waitForLine(lines, start, line => /^ok\b/.test(line), 30_000)
    log(`  SD list: ${lines.slice(start).filter(line => line !== 'ok').join(' | ') || '(empty)'}`)

    const filename = `filum-spike-${Date.now().toString(36)}.txt`
    const content = 'Filum transport spike: text-only diagnostic file.\n'
    const size = new Blob([content]).size
    const body = new FormData()
    body.append('path', '/')
    body.append(filename + 'S', String(size))
    body.append('myfile', new Blob([content], { type: 'text/plain' }), filename)
    const response = await boardTransport.postMultipart(`${url.origin}/upload`, body, 600_000)
    log(`  upload response: ${response.status ?? (response.ok ? 'opaque/sent' : 'failed')}${response.err ? ` (${response.err})` : ''}`)

    start = lines.length
    socket.send('$SD/List\n')
    await waitForLine(lines, start, line => /^ok\b/.test(line), 30_000)
    const uploaded = lines.slice(start).find(line => line.includes(filename) && line.includes(`SIZE: ${size}`))
    if (uploaded) log(`  upload verified: ${uploaded}`)
    else log(`  upload not verified in SD listing; check manually for /${filename}`)
    log(`  diagnostic file left on SD card: /${filename}`)
  } finally {
    socket?.close()
  }
}

export async function runNetworkSpike(address: string, log: SpikeLog): Promise<void> {
  for (const transport of ['webview', 'rust'] as const) {
    log(`\n${transport.toUpperCase()} transport`)
    try {
      await testTransport(address, transport, log)
    } catch (error) {
      log(`  transport failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
