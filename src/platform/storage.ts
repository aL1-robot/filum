import { load } from '@tauri-apps/plugin-store'
import { isTauri } from './runtime.ts'

export type AppPreferences = {
  theme: unknown
  measurements: unknown
  address: unknown
}

const STORE_FILE = 'filum-settings.json'
const THEME_KEY = 'filum-theme'
const MEASUREMENTS_KEY = 'needleCal1'
const ADDRESS_KEY = 'fluidnc-address'

let storePromise: ReturnType<typeof load> | undefined

function getStore() {
  storePromise ??= load(STORE_FILE, { autoSave: false })
  return storePromise
}

function readBrowserValue(key: string): unknown {
  const value = window.localStorage.getItem(key)
  if (value == null) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

async function getValue(key: string): Promise<unknown> {
  if (!isTauri()) return readBrowserValue(key)

  const store = await getStore()
  const value = await store.get<unknown>(key)
  if (value !== undefined) return value

  const legacyValue = readBrowserValue(key)
  if (legacyValue !== undefined) {
    await store.set(key, legacyValue)
    await store.save()
  }
  return legacyValue
}

export async function loadAppPreferences(): Promise<AppPreferences> {
  const [theme, measurements, address] = await Promise.all([
    getValue(THEME_KEY),
    getValue(MEASUREMENTS_KEY),
    getValue(ADDRESS_KEY),
  ])
  return { theme, measurements, address }
}

export async function savePreference(key: string, value: unknown): Promise<void> {
  if (isTauri()) {
    const store = await getStore()
    await store.set(key, value)
    await store.save()
    return
  }

  window.localStorage.setItem(key, JSON.stringify(value))
}
