import { useCallback, useEffect, useRef, useState } from 'react'
import { agentApply, agentAsk, agentCancel, agentUndo, agentWarm, type AgentChange, type AgentTurn, type Snapshot } from './api'

export type Status = 'proposed' | 'applied' | 'discarded' | 'replaced' | 'undone'

export type Entry =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; reply: string; changes: AgentChange[]; skipped: number[]; status: Status; snapshots?: Snapshot[]; note?: string }
  | { id: number; role: 'error'; text: string; retry: string }

export type Assistant = Extract<Entry, { role: 'assistant' }>

export type AgentThread = ReturnType<typeof useAgentThread>

let nextEntry = 0

/**
 * The conversation, kept by the app so it survives moving between pages.
 * `beforeWrite` saves any pending edit first; `afterWrite` runs once notes changed on disk.
 */
export function useAgentThread(beforeWrite: () => Promise<void> | void, afterWrite: () => void) {
  const [thread, setThread] = useState<Entry[]>([])
  const [pending, setPending] = useState(false)
  const request = useRef(0)
  const current = useRef(thread)
  useEffect(() => {
    current.current = thread
  })

  const update = useCallback((id: number, change: Partial<Assistant>) => {
    setThread((entries) => entries.map((e) => (e.id === id && e.role === 'assistant' ? { ...e, ...change } : e)))
  }, [])

  const send = useCallback(async (text: string) => {
    const message = text.trim()
    if (!message) return
    const id = ++request.current
    const asked = [...answered(current.current), { id: nextEntry++, role: 'user' as const, text: message }]
    setThread(asked)
    setPending(true)
    try {
      const plan = await agentAsk(asked.map(toTurn))
      if (id !== request.current) return
      setThread((entries) => [
        // A new proposal replaces the one still waiting, as the agent was told.
        ...entries.map((e) => (plan.changes.length && e.role === 'assistant' && e.status === 'proposed' ? { ...e, status: 'replaced' as const } : e)),
        { id: nextEntry++, role: 'assistant', reply: plan.reply, changes: plan.changes, skipped: [], status: 'proposed' },
      ])
    } catch (e) {
      if (id !== request.current) return
      setThread((entries) => [...entries, { id: nextEntry++, role: 'error', text: String(e).replace(/^Error: /, ''), retry: message }])
    } finally {
      if (id === request.current) setPending(false)
    }
  }, [])

  const stop = useCallback(() => {
    request.current++
    agentCancel()
    setPending(false)
  }, [])

  const reset = useCallback(() => {
    if (pending) stop()
    setThread([])
    // The next message starts a new conversation, so have a fresh process ready for it.
    agentWarm()
  }, [pending, stop])

  const apply = useCallback(
    async (entry: Assistant) => {
      const changes = entry.changes.filter((_, i) => !entry.skipped.includes(i))
      if (!changes.length) return update(entry.id, { status: 'discarded' })
      await beforeWrite()
      try {
        const snapshots = await agentApply(changes)
        update(entry.id, { status: 'applied', snapshots, note: undefined })
      } catch (e) {
        update(entry.id, { note: String(e).replace(/^Error: /, '') })
      }
      afterWrite()
    },
    [beforeWrite, afterWrite, update],
  )

  const undo = useCallback(
    async (entry: Assistant) => {
      await beforeWrite()
      const skipped = await agentUndo(entry.snapshots ?? []).catch(() => entry.snapshots?.length ?? 0)
      const note = skipped ? `${skipped === 1 ? 'A note' : `${skipped} notes`} changed since, so ${skipped === 1 ? 'it was' : 'they were'} left alone.` : undefined
      update(entry.id, { status: 'undone', note })
      afterWrite()
    },
    [beforeWrite, afterWrite, update],
  )

  const toggle = useCallback((entry: Assistant, index: number) => {
    const skipped = entry.skipped.includes(index) ? entry.skipped.filter((i) => i !== index) : [...entry.skipped, index]
    update(entry.id, { skipped })
  }, [update])

  const discard = useCallback((entry: Assistant) => update(entry.id, { status: 'discarded' }), [update])

  const waiting = thread.some((e) => e.role === 'assistant' && e.status === 'proposed' && e.changes.length > 0)
  return { thread, pending, waiting, send, stop, reset, apply, undo, toggle, discard }
}

/** The thread without failed messages and their errors, which shouldn't go to the agent again. */
function answered(entries: Entry[]) {
  return entries.filter((e, i) => e.role !== 'error' && !(e.role === 'user' && entries[i + 1]?.role === 'error'))
}

function toTurn(entry: Entry): AgentTurn {
  if (entry.role === 'assistant') {
    const changes = entry.changes.filter((_, i) => !entry.skipped.includes(i))
    return { role: 'assistant', text: entry.reply, changes, applied: entry.status === 'applied' }
  }
  return { role: 'user', text: entry.role === 'user' ? entry.text : '' }
}

