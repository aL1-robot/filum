import { appDataDir, join } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { BaseDirectory, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { isAndroid, isTauri } from './runtime.ts'

export type TextDocument = { name: string; text: string }

function fileName(path: string): string {
  return decodeURIComponent(path.split(/[\\/]/).at(-1) ?? path)
}

export async function openTextDocument(extensions: string[]): Promise<TextDocument | null> {
  if (!isTauri()) return null

  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Text files', extensions }],
  })
  if (typeof selected !== 'string') return null

  return { name: fileName(selected), text: await readTextFile(selected) }
}

export async function saveTextDocument(name: string, text: string, extension: string): Promise<string | null> {
  if (!isTauri()) return null

  try {
    const selected = await save({
      defaultPath: name,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    })
    if (!selected) return null
    await writeTextFile(selected, text)
    return selected
  } catch (error) {
    if (!isAndroid()) throw error

    console.warn('Android save dialog failed; writing the file to Filum app storage instead.', error)
    const path = await join(await appDataDir(), name)
    await writeTextFile(name, text, { baseDir: BaseDirectory.AppData })
    return path
  }
}
