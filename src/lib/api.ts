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

// The agent: it proposes changes to the notes, which only get written once you apply them.

export type AgentAction = 'add' | 'done' | 'move' | 'edit' | 'remove'

/** An existing task, as it was when the change was proposed. */
export type TaskRef = { note: string; line: number; text: string }

/** `note` is where an added or moved task goes, otherwise the note the task is in. */
export type AgentChange = { action: AgentAction; note: string; text: string; subtasks: string[]; task: TaskRef | null }

export type AgentPlan = { reply: string; changes: AgentChange[] }

export type AgentTurn = { role: 'user' | 'assistant'; text: string; changes?: AgentChange[]; applied?: boolean }

/** A note before and after a plan was applied, for undo. */
export type Snapshot = { id: string; before: string; after: string }

export type ProviderId = 'claude' | 'codex' | 'openrouter'

/** An empty model means the provider's default. */
export type AgentPrefs = { provider: ProviderId; claudeModel: string; codexModel: string; openrouterModel: string }

export type ProviderStatus = { id: ProviderId; ready: boolean; detail: string }

export type AgentSettings = { prefs: AgentPrefs; providers: ProviderStatus[] }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export function agentAsk(turns: AgentTurn[]) {
  if (isNative) return invoke<AgentPlan>('agent_ask', { turns })
  return post<AgentPlan>('/api/agent/ask', turns)
}

export function agentApply(changes: AgentChange[]) {
  if (isNative) return invoke<Snapshot[]>('agent_apply', { changes })
  return post<Snapshot[]>('/api/agent/apply', changes)
}

/** Puts the notes back; returns how many had changed since and were left alone. */
export function agentUndo(snapshots: Snapshot[]) {
  if (isNative) return invoke<number>('agent_undo', { snapshots })
  return post<number>('/api/agent/undo', snapshots)
}

export function agentWarm() {
  if (isNative) invoke('agent_warm')
}

export function agentCancel() {
  if (isNative) invoke('agent_cancel')
}

export async function agentSettings(): Promise<AgentSettings | null> {
  return isNative ? invoke<AgentSettings>('agent_settings') : null
}

export function setAgentPrefs(prefs: AgentPrefs) {
  return invoke<void>('set_agent_prefs', { prefs })
}

export function connectOpenRouter() {
  return invoke<void>('connect_openrouter')
}

export function setOpenRouterKey(key: string) {
  return invoke<void>('set_openrouter_key', { key })
}

export function clearOpenRouterKey() {
  return invoke<void>('clear_openrouter_key')
}

/** From the quick capture panel: opens the main window and asks the agent there. */
export function quickAsk(text: string) {
  return invoke<void>('quick_ask', { text })
}
