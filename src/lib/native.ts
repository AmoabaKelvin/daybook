import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'

/** True inside the Mac app, false when running in a browser via `pnpm dev`. */
export const isNative = '__TAURI_INTERNALS__' in window

export { invoke }

export function openLink(href: string) {
  if (isNative) openUrl(href)
  else window.open(href, '_blank', 'noopener')
}

/** The app asks before quitting so the last keystrokes get saved. */
export function onQuit(save: () => Promise<void> | void) {
  if (!isNative) return () => {}
  const stop = listen('daybook://quit', async () => {
    await save()
    await invoke('quit')
  })
  return () => {
    stop.then((unlisten) => unlisten())
  }
}

/** A note changed on disk because of something other than the app (the CLI, an agent, an editor). */
export function onNoteChanged(handle: (id: string, content: string) => void) {
  if (!isNative) return () => {}
  const stop = listen<{ id: string; content: string }>('daybook://changed', (event) => handle(event.payload.id, event.payload.content))
  return () => {
    stop.then((unlisten) => unlisten())
  }
}
