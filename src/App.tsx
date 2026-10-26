import type { Editor } from '@tiptap/core'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { summarize } from '../shared/summary'
import { Capture } from './components/Capture'
import { NoteEditor } from './components/NoteEditor'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { forgetLinks, listNotes, loadNote, saveNote, type NoteSummary } from './lib/api'
import { BACKLOG, dayId, isDay, shortLabel, titleFor } from './lib/dates'
import { forgetLinkStates } from './lib/extensions'
import { onNoteChanged, onQuit } from './lib/native'
import { appendTasks, appendToMarkdown, applyMarkdown, mergeMarkdown, openTasks, toTaskBlock } from './lib/tasks'

type Doc = { id: string; markdown: string; rev: number }

const SAVE_DELAY = 400

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

  const editor = useRef<Editor | null>(null)
  // The open note's markdown as of the last edit, and the unsaved part of it.
  const text = useRef<{ id: string; markdown: string } | null>(null)
  const latest = useRef<{ id: string; markdown: string } | null>(null)
  // What each note looked like on disk when we last read or wrote it: the base for merges.
  const base = useRef(new Map<string, string>())
  const saveTimer = useRef<number | undefined>(undefined)

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
    Promise.resolve(flush()).then(() =>
      loadNote(current).then((markdown) => {
        if (cancelled) return
        base.current.set(current, markdown)
        text.current = { id: current, markdown }
        setDoc({ id: current, markdown, rev: 0 })
      }),
    )
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
    const days = [...notes.keys()].filter((id) => isDay(id) && id !== today).sort().reverse()
    return [BACKLOG, today, ...days]
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

  // After connecting or disconnecting Linear, look every link up again.
  function onLinksChanged() {
    forgetLinks()
    forgetLinkStates()
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

  // Yesterday's leftovers, offered when today is still empty.
  const carry = useMemo(() => {
    const todayNote = notes.get(today)
    if (current !== today || dismissedCarry || (todayNote && todayNote.open + todayNote.done > 0)) return null
    return [...notes.values()].filter((n) => isDay(n.id) && n.id < today && n.open > 0).sort((a, b) => b.id.localeCompare(a.id))[0] ?? null
  }, [notes, today, current, dismissedCarry])

  async function carryOver() {
    if (!carry) return
    const tasks = openTasks(await loadNote(carry.id))
    if (tasks) await addTasks(today, tasks)
    setDismissedCarry(true)
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCapturing((c) => !c)
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

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const summary = doc ? notes.get(doc.id) : undefined
  const total = summary ? summary.open + summary.done : 0
  const heading = doc ? titleFor(doc.id) : null

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
            <Sidebar ids={ids} notes={notes} current={current} onSelect={setCurrent} />
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

        <div className="scroll">
          <AnimatePresence mode="wait" initial={false}>
            {doc && heading && (
              <motion.article
                key={doc.id}
                className="page"
                initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -6, filter: 'blur(2px)', transition: { duration: 0.12 } }}
                transition={{ type: 'spring', stiffness: 380, damping: 34 }}
              >
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

      <Capture open={capturing} onClose={() => setCapturing(false)} onSubmit={capture} />
      <Settings open={settingsOpen} onClose={closeSettings} onLinksChanged={onLinksChanged} />

      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
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
