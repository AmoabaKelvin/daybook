import type { Editor } from '@tiptap/core'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { summarize } from '../shared/summary'
import { Agent } from './components/Agent'
import { Assigned } from './components/Assigned'
import { Capture } from './components/Capture'
import { NoteEditor } from './components/NoteEditor'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { useAgentThread } from './lib/agent'
import { agentSettings, assigned, forgetLinks, listNotes, loadNote, saveNote, type AgentSettings, type AssignedWork, type NoteSummary, type WorkItem } from './lib/api'
import { AGENT, ASSIGNED, BACKLOG, dayId, isDay, shortLabel, titleFor } from './lib/dates'
import { forgetLinkStates } from './lib/extensions'
import { onAsk, onNoteChanged, onQuit } from './lib/native'
import { appendTasks, appendToMarkdown, applyMarkdown, linkTask, markMoved, mergeMarkdown, openTasks, toTaskBlock } from './lib/tasks'

type Doc = { id: string; markdown: string; rev: number }

const SAVE_DELAY = 400
// Coming back to the window checks for new assigned work, but not more often than this.
const WORK_RECHECK = 30_000

const pageMotion = {
  initial: { opacity: 0, y: 10, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -6, filter: 'blur(2px)', transition: { duration: 0.12 } },
  transition: { type: 'spring', stiffness: 380, damping: 34 },
} as const

export default function App() {
  const today = dayId()
  const [notes, setNotes] = useState(new Map<string, NoteSummary>())
  const [current, setCurrent] = useState(today)
  const [doc, setDoc] = useState<Doc | null>(null)
  const [source, setSource] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [capturing, setCapturing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [dismissedCarry, setDismissedCarry] = useState(false)
  const [work, setWork] = useState<AssignedWork | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [agentPrefs, setAgentPrefs] = useState<AgentSettings | null>(null)

  const editor = useRef<Editor | null>(null)
  // The open note's markdown as of the last edit, and the unsaved part of it.
  const text = useRef<{ id: string; markdown: string } | null>(null)
  const latest = useRef<{ id: string; markdown: string } | null>(null)
  // What each note looked like on disk when we last read or wrote it: the base for merges.
  const base = useRef(new Map<string, string>())
  const saveTimer = useRef<number | undefined>(undefined)
  const workRequest = useRef({ id: 0, at: 0 })

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    const pending = latest.current
    latest.current = null
    if (!pending) return
    base.current.set(pending.id, pending.markdown)
    return saveNote(pending.id, pending.markdown)
  }, [])

  const record = useCallback((id: string, markdown: string) => {
    setNotes((prev) => {
      const next = new Map(prev)
      if (markdown.trim() || id === BACKLOG) next.set(id, summarize(id, markdown))
      else next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    listNotes().then((list) => setNotes(new Map(list.map((n) => [n.id, n]))))
    window.addEventListener('beforeunload', flush)
    const stopQuit = onQuit(flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      stopQuit()
    }
  }, [flush])

  useEffect(() => {
    let cancelled = false
    Promise.resolve(flush()).then(() => {
      // The assigned and agent pages aren't notes, so no note is open while they show.
      if (current === ASSIGNED || current === AGENT) return setDoc(null)
      return loadNote(current).then((markdown) => {
        if (cancelled) return
        base.current.set(current, markdown)
        text.current = { id: current, markdown }
        setDoc({ id: current, markdown, rev: 0 })
      })
    })
    return () => {
      cancelled = true
    }
  }, [current, flush])

  const onChange = useCallback(
    (markdown: string) => {
      if (!doc) return
      text.current = { id: doc.id, markdown }
      latest.current = { id: doc.id, markdown }
      record(doc.id, markdown)
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(flush, SAVE_DELAY)
    },
    [doc, flush, record],
  )

  const onReady = useCallback((instance: Editor | null) => {
    editor.current = instance
  }, [])

  const ids = useMemo(() => {
    const days = [...notes.keys()].filter((id) => isDay(id) && id !== today).sort()
    // Today, then the days ahead in order, then earlier days newest first.
    return [BACKLOG, ASSIGNED, AGENT, today, ...days.filter((id) => id > today), ...days.filter((id) => id < today).reverse()]
  }, [notes, today])

  function currentMarkdown() {
    if (!doc) return ''
    return text.current?.id === doc.id ? text.current.markdown : doc.markdown
  }

  // Something else (the CLI, an agent, another editor) changed a note on disk.
  function onExternalChange(id: string, remote: string) {
    const known = base.current.get(id) ?? ''
    if (known.trimEnd() === remote.trimEnd()) return
    base.current.set(id, remote)
    if (doc?.id !== id) {
      record(id, remote)
      return
    }
    const local = currentMarkdown()
    const merged = local.trimEnd() === known.trimEnd() ? remote : mergeMarkdown(local, known, remote)
    if (!source && editor.current) {
      applyMarkdown(editor.current, merged)
    } else {
      setDoc({ ...doc, markdown: merged, rev: doc.rev + 1 })
      onChange(merged)
    }
  }
  const externalChange = useRef(onExternalChange)
  useEffect(() => {
    externalChange.current = onExternalChange
  })
  useEffect(() => onNoteChanged((id, content) => externalChange.current(id, content)), [])

  const loadWork = useCallback((fresh: boolean) => {
    const id = ++workRequest.current.id
    workRequest.current.at = Date.now()
    assigned(fresh)
      .catch((e) => ({ github: null, linear: null, githubError: String(e), linearError: null }))
      .then((next) => {
        if (id !== workRequest.current.id) return
        setWork(next)
        setRefreshing(false)
      })
  }, [])

  const refreshWork = useCallback(() => {
    setRefreshing(true)
    loadWork(true)
  }, [loadWork])

  useEffect(() => {
    loadWork(false)
    const onFocus = () => Date.now() - workRequest.current.at > WORK_RECHECK && refreshWork()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadWork, refreshWork])

  const reloadNotes = useCallback(() => {
    listNotes().then((list) => setNotes(new Map(list.map((n) => [n.id, n]))))
  }, [])
  const agent = useAgentThread(flush, reloadNotes)
  const { send } = agent

  const loadAgentSettings = useCallback(() => {
    agentSettings().then(setAgentPrefs).catch(() => {})
  }, [])
  useEffect(loadAgentSettings, [loadAgentSettings])

  // ⌘↵ in the capture box, here or over another app, hands what was typed to the agent.
  const ask = useCallback(
    (text: string) => {
      setCapturing(false)
      setCurrent(AGENT)
      send(text)
    },
    [send],
  )
  useEffect(() => onAsk(ask), [ask])

  // After connecting or disconnecting Linear, look every link up again.
  function onLinksChanged() {
    forgetLinks()
    forgetLinkStates()
    refreshWork()
    if (doc && !source) setDoc({ ...doc, markdown: currentMarkdown(), rev: doc.rev + 1 })
  }

  function toggleSource() {
    if (!doc) return
    const markdown = currentMarkdown()
    setSource((s) => !s)
    setDoc({ ...doc, markdown, rev: doc.rev + 1 })
  }

  async function addTasks(id: string, tasks: string) {
    if (doc?.id === id && !source && editor.current) {
      appendTasks(editor.current, tasks)
      return
    }
    if (doc?.id === id) {
      const markdown = appendToMarkdown(currentMarkdown(), tasks)
      setDoc({ ...doc, markdown, rev: doc.rev + 1 })
      onChange(markdown)
      return
    }
    const markdown = appendToMarkdown(await loadNote(id), tasks)
    base.current.set(id, markdown)
    await saveNote(id, markdown)
    record(id, markdown)
    setToast(`Added to ${shortLabel(id)}`)
  }

  async function capture(text: string, subtasks: string[], target: 'today' | typeof BACKLOG) {
    await addTasks(target === 'today' ? today : BACKLOG, await toTaskBlock(text, subtasks))
  }

  async function pull(item: WorkItem, target: 'today' | typeof BACKLOG) {
    await addTasks(target === 'today' ? today : BACKLOG, linkTask(item.title, item.url))
  }

  // Yesterday's leftovers, offered when today is still empty.
  const carry = useMemo(() => {
    const todayNote = notes.get(today)
    if (current !== today || dismissedCarry || (todayNote && todayNote.open + todayNote.done + todayNote.moved > 0)) return null
    return [...notes.values()].filter((n) => isDay(n.id) && n.id < today && n.open > 0).sort((a, b) => b.id.localeCompare(a.id))[0] ?? null
  }, [notes, today, current, dismissedCarry])

  async function carryOver() {
    if (!carry) return
    const markdown = await loadNote(carry.id)
    const tasks = openTasks(markdown)
    if (tasks) {
      await addTasks(today, tasks)
      // The tasks now live on today, so the day they came from shows them as moved.
      const moved = markMoved(markdown)
      base.current.set(carry.id, moved)
      record(carry.id, moved)
      await saveNote(carry.id, moved)
    }
    setDismissedCarry(true)
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCapturing((c) => !c)
      } else if (mod && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setCurrent(ASSIGNED)
      } else if (mod && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setCurrent(AGENT)
      } else if (mod && event.key === ',') {
        event.preventDefault()
        setSettingsOpen((s) => !s)
      } else if (mod && event.key === '\\') {
        event.preventDefault()
        setSidebar((s) => !s)
      } else if (mod && event.key === '/') {
        event.preventDefault()
        toggleSource()
      } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        const index = ids.indexOf(current) + (event.key === 'ArrowUp' ? -1 : 1)
        if (ids[index]) setCurrent(ids[index])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  // A linked PR merged or an issue closed, so its task got ticked off.
  useEffect(() => {
    function onTicked(event: Event) {
      const { title, state } = (event as CustomEvent<{ title: string; state: string }>).detail
      const short = title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title
      setToast(`${state === 'merged' ? 'Merged' : 'Done'}: ticked off “${short}”`)
    }
    window.addEventListener('daybook:ticked', onTicked)
    return () => window.removeEventListener('daybook:ticked', onTicked)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    loadAgentSettings()
  }, [loadAgentSettings])

  const summary = doc ? notes.get(doc.id) : undefined
  const total = summary ? summary.open + summary.done : 0
  const heading = doc ? titleFor(doc.id) : null
  const workCount = work && (work.github?.length ?? 0) + (work.linear?.length ?? 0)

  return (
    <div className={sidebar ? 'app' : 'app sidebar-hidden'}>
      <AnimatePresence initial={false}>
        {sidebar && (
          <motion.aside
            className="sidebar-wrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 232, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
          >
            <Sidebar
              ids={ids}
              notes={notes}
              current={current}
              assignedCount={workCount}
              agentState={agent.pending ? 'thinking' : agent.waiting ? 'waiting' : null}
              onSelect={setCurrent}
            />
          </motion.aside>
        )}
      </AnimatePresence>

      <main className="main">
        <div className="toolbar" data-tauri-drag-region>
          <button className="icon-button" onClick={() => setSidebar((s) => !s)} title="Toggle sidebar (⌘\)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.5" />
              <path d="M6 3v10" />
            </svg>
          </button>
          <div className="toolbar-right">
            <button className={source ? 'icon-button on' : 'icon-button'} onClick={toggleSource} title="Markdown source (⌘/)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
              </svg>
            </button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings (⌘,)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
                <circle cx="10" cy="4.5" r="1.5" />
                <circle cx="6" cy="11.5" r="1.5" />
              </svg>
            </button>
            <button className="capture-button" onClick={() => setCapturing(true)}>
              <span>Capture</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        </div>

        <div className={current === AGENT ? 'scroll agent-scroll' : 'scroll'}>
          <AnimatePresence mode="wait" initial={false}>
            {current === AGENT ? (
              <motion.article key={AGENT} className="page agent-page" {...pageMotion}>
                <Agent
                  agent={agent}
                  settings={agentPrefs}
                  paused={capturing || settingsOpen}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onOpenNote={setCurrent}
                />
              </motion.article>
            ) : current === ASSIGNED ? (
              <motion.article key={ASSIGNED} className="page" {...pageMotion}>
                <Assigned
                  work={work}
                  refreshing={refreshing}
                  notes={notes}
                  paused={capturing || settingsOpen}
                  onRefresh={refreshWork}
                  onAdd={pull}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              </motion.article>
            ) : doc && heading && (
              <motion.article key={doc.id} className="page" {...pageMotion}>
                <header className="page-header">
                  <h1>{heading.title}</h1>
                  <div className="page-meta">
                    <span>{heading.subtitle}</span>
                    {total > 0 && (
                      <span className="progress">
                        <span className="progress-track">
                          <motion.span
                            className="progress-fill"
                            animate={{ width: `${(summary!.done / total) * 100}%` }}
                            transition={{ type: 'spring', stiffness: 260, damping: 30 }}
                          />
                        </span>
                        {summary!.done}/{total}
                      </span>
                    )}
                  </div>
                </header>

                <AnimatePresence>
                  {carry && (
                    <motion.button
                      className="carry"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                      onClick={carryOver}
                    >
                      <span>
                        Bring over {carry.open} unfinished from {shortLabel(carry.id).toLowerCase() === 'yesterday' ? 'yesterday' : shortLabel(carry.id)}
                      </span>
                      <span
                        className="carry-dismiss"
                        role="button"
                        aria-label="Dismiss"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDismissedCarry(true)
                        }}
                      >
                        ×
                      </span>
                    </motion.button>
                  )}
                </AnimatePresence>

                {source ? (
                  <textarea
                    key={`${doc.id}:${doc.rev}`}
                    className="source"
                    defaultValue={doc.markdown}
                    onChange={(e) => onChange(e.target.value)}
                    autoFocus
                    spellCheck={false}
                  />
                ) : (
                  <NoteEditor
                    key={`${doc.id}:${doc.rev}`}
                    initial={doc.markdown}
                    placeholder={doc.id === BACKLOG ? 'Things for later…' : 'What needs doing? Type [ ] for a task, or paste a link…'}
                    onChange={onChange}
                    onReady={onReady}
                  />
                )}
              </motion.article>
            )}
          </AnimatePresence>
        </div>
      </main>

      <Capture open={capturing} onClose={() => setCapturing(false)} onSubmit={capture} onAsk={ask} />
      <Settings open={settingsOpen} onClose={closeSettings} onLinksChanged={onLinksChanged} />

      <AnimatePresence>
        {toast && (
          <motion.div
            className={current === AGENT ? 'toast raised' : 'toast'}
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
