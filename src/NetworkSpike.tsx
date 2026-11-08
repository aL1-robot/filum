import { useState } from 'react'
import { isAndroid, isTauri } from './platform/runtime.ts'
import { runNetworkSpike } from './platform/spike.ts'

export default function NetworkSpike({ address }: { address: string }) {
  const [target, setTarget] = useState(address)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const platform = isAndroid() ? 'Android' : isTauri() ? 'Tauri desktop' : 'Browser'

  async function run() {
    setRunning(true)
    setResults([`Platform: ${platform}`, 'This test uploads a uniquely named text file and leaves it on the board SD card.'])
    try {
      await runNetworkSpike(target, line => setResults(current => [...current, line]))
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="network-spike">
      <h1>Filum network spike</h1>
      <p>Runs the WebView transport first, then the Rust-backed Tauri transport. Sends one status query, lists SD files, and uploads a small text-only diagnostic file.</p>
      {!isTauri() && <p>Rust-backed transport is only available in a packaged Tauri app.</p>}
      <label>
        FluidNC address
        <input value={target} onChange={event => setTarget(event.target.value)} />
      </label>
      <button disabled={running} onClick={() => void run()}>{running ? 'Testing…' : 'Run transport spike'}</button>
      <pre aria-live="polite">{results.join('\n')}</pre>
    </main>
  )
}
