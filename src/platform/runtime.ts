import { isTauri as isTauriRuntime } from '@tauri-apps/api/core'

export function isTauri(): boolean {
  return isTauriRuntime()
}

export function isAndroid(): boolean {
  return isTauri() && /Android/i.test(navigator.userAgent)
}
