import { summarize, type NoteSummary } from '../../shared/summary.ts'
import { invoke, isNative } from './native'

export type { NoteSummary }

/**
 * Live details for a link. GitHub states: open, draft, merged, closed.
 * Linear states are its state types: triage, backlog, unstarted, started, completed, canceled.
 */
export type LinkInfo = { title: string; state: string; status?: string | null }

export type LinearAccount = { name: string; workspace: string }

export type Settings = {
  notesDir: string
  githubLogin: string | null
  linear: LinearAccount | null
  linearError: string | null
  cliPath: string
  cliInstalled: boolean
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
