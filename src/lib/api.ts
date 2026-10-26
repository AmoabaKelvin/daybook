import { summarize, type NoteSummary } from '../../shared/summary.ts'
import { invoke, isNative } from './native'

export type { NoteSummary }

/**
 * Live details for a link. GitHub states: open, draft, merged, closed.
 * Linear states are its state types: triage, backlog, unstarted, started, completed, canceled.
 */
export type LinkInfo = { title: string; state: string; status?: string | null }

export type LinearAccount = { name: string; workspace: string }

/** A PR waiting on your review, or an issue or PR assigned to you. `state` uses LinkInfo's words. */
export type WorkItem = {
  source: 'github' | 'linear'
  kind: 'pull' | 'issue'
  url: string
  title: string
  ref: string
  state: string
  status: string | null
  group: 'review' | 'assigned'
  updated: number
}

/** A source is null when it isn't connected (no `gh` login, no Linear key) or couldn't be loaded. */
export type AssignedWork = {
  github: WorkItem[] | null
  linear: WorkItem[] | null
  githubError: string | null
  linearError: string | null
}

/** An accelerator like "Alt+Space", or null when quick capture is off. */
export type CaptureShortcut = { shortcut: string | null; error: string | null }

export type Settings = {
  notesDir: string
  githubLogin: string | null
  linear: LinearAccount | null
  linearError: string | null
  cliPath: string
  cliInstalled: boolean
  captureShortcut: CaptureShortcut
}

type NoteFile = { id: string; content: string; updated: number }

export async function listNotes(): Promise<NoteSummary[]> {
  if (isNative) {
    const files = await invoke<NoteFile[]>('list_notes')
    return files.map((f) => summarize(f.id, f.content, f.updated))
  }
  const res = await fetch('/api/notes')
  return res.json()
}

export async function loadNote(id: string): Promise<string> {
  if (isNative) return invoke<string>('load_note', { id })
  const res = await fetch(`/api/notes/${id}`)
  return res.text()
}

export async function saveNote(id: string, markdown: string) {
  if (isNative) return invoke<void>('save_note', { id, content: markdown })
  await fetch(`/api/notes/${id}`, { method: 'PUT', body: markdown })
}

const linkRequests = new Map<string, Promise<LinkInfo | null>>()

function requestLink(url: string): Promise<LinkInfo | null> {
  if (isNative) return invoke<LinkInfo | null>('link_info', { url })
  return fetch(`/api/github?url=${encodeURIComponent(url)}`).then((res) => res.json())
}

export function linkInfo(url: string, fresh = false): Promise<LinkInfo | null> {
  if (fresh || !linkRequests.has(url)) {
    linkRequests.set(url, requestLink(url).catch(() => null))
  }
  return linkRequests.get(url)!
}

export function forgetLinks() {
  linkRequests.clear()
}

export function assigned(fresh = false): Promise<AssignedWork> {
  if (isNative) return invoke<AssignedWork>('list_assigned', { fresh })
  return fetch(`/api/assigned${fresh ? '?fresh' : ''}`).then((res) => res.json())
}

// Settings live in the Mac app; in the browser they're read-only defaults.

export async function getSettings(): Promise<Settings | null> {
  return isNative ? invoke<Settings>('get_settings') : null
}

export function setLinearKey(key: string) {
  return invoke<LinearAccount>('set_linear_key', { key })
}

export function clearLinearKey() {
  return invoke<void>('clear_linear_key')
}

export function installCli() {
  return invoke<string>('install_cli')
}

export function revealNotes() {
  return invoke<void>('reveal_notes')
}

export function setCaptureShortcut(shortcut: string | null) {
  return invoke<void>('set_capture_shortcut', { shortcut })
}

// The quick capture panel, which only exists in the Mac app.

export function quickAdd(target: string, tasks: string) {
  return invoke<void>('quick_add', { target, tasks })
}

export function hideQuick() {
  return invoke<void>('hide_quick')
}

export function resizeQuick(height: number) {
  return invoke<void>('resize_quick', { height })
}
