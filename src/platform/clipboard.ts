import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { isTauri } from './runtime.ts'

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text)
    return
  }

  if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.')
  await navigator.clipboard.writeText(text)
}
