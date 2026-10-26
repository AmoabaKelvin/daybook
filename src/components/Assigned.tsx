import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { loadNote, type AssignedWork, type NoteSummary, type WorkItem } from '../lib/api'
import { ASSIGNED, BACKLOG, dayId, titleFor } from '../lib/dates'
import { openLink } from '../lib/native'

type Target = 'today' | typeof BACKLOG
type Filter = 'all' | 'github' | 'linear'

type Props = {
  work: AssignedWork | null
  refreshing: boolean
  notes: Map<string, NoteSummary>
  /** True while a dialog is open over the page, so its keys are left alone. */
  paused: boolean
  onRefresh: () => void
  onAdd: (item: WorkItem, target: Target) => Promise<void>
  onOpenSettings: () => void
}

type Section = { key: 'review' | 'github' | 'linear'; title: string; items: WorkItem[] | null; empty: string }

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['github', 'GitHub'],
  ['linear', 'Linear'],
]
const LINEAR_ORDER = ['started', 'unstarted', 'backlog', 'triage']
const spring = { type: 'spring', stiffness: 420, damping: 38 } as const

export function Assigned({ work, refreshing, notes, paused, onRefresh, onAdd, onOpenSettings }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [planned, setPlanned] = useState({ today: '', backlog: '' })
  const rows = useRef(new Map<string, HTMLElement>())
  const heading = titleFor(ASSIGNED)

  // Today's and the backlog's markdown, read again whenever either note changes.
  const today = dayId()
  const todayNote = notes.get(today)
  const backlogNote = notes.get(BACKLOG)
  useEffect(() => {
    let cancelled = false
    Promise.all([loadNote(today), loadNote(BACKLOG)]).then(([t, b]) => !cancelled && setPlanned({ today: t, backlog: b }))
    return () => {
      cancelled = true
    }
  }, [today, todayNote, backlogNote])

  const sections = work ? sectionsFor(work, filter) : []
  const visible = sections.flatMap((s) => s.items ?? [])
  const isIn = (item: WorkItem, target: Target) => mentions(target === 'today' ? planned.today : planned.backlog, item)

  function add(item: WorkItem, target: Target) {
    if (!isIn(item, target)) onAdd(item, target)
  }

  useEffect(() => {
    if (paused) return
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (event.metaKey || event.ctrlKey || event.altKey || target.closest?.('input, textarea, [contenteditable="true"]')) return
      const index = visible.findIndex((item) => item.url === selected)
      const item = visible[index]
      const key = event.key.toLowerCase()
      if (key === 'arrowdown' || key === 'arrowup') {
        event.preventDefault()
        const next = visible[key === 'arrowdown' ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0)]
        if (!next) return
        setSelected(next.url)
        rows.current.get(next.url)?.scrollIntoView({ block: 'nearest' })
      } else if (key === 'enter' && item) {
        event.preventDefault()
        openLink(item.url)
      } else if (key === 't' && item) add(item, 'today')
      else if (key === 'b' && item) add(item, BACKLOG)
      else if (key === 'r') onRefresh()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <header className="page-header work-header">
        <div>
          <h1>{heading.title}</h1>
          <div className="page-meta">
            <span>{heading.subtitle}</span>
          </div>
        </div>
        <div className="work-controls">
          <div className="segmented" role="radiogroup" aria-label="Show">
            {FILTERS.map(([value, label]) => (
              <button key={value} role="radio" aria-checked={filter === value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>
                {filter === value && <motion.span layoutId="work-filter" className="segmented-pill" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button className={refreshing ? 'icon-button work-refresh busy' : 'icon-button work-refresh'} onClick={onRefresh} title="Refresh (R)" aria-label="Refresh">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
              <path d="M13.25 2.5v2.75H10.5" />
            </svg>
          </button>
        </div>
      </header>

      {!work ? (
        <Skeleton />
      ) : (
        <div className="work">
          <AnimatePresence initial={false} mode="popLayout">
            {sections.map((section) => (
              <motion.section
                key={section.key}
                layout="position"
                className="work-section"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={spring}
              >
                <h2>
                  {section.title}
                  {!!section.items?.length && <span>{section.items.length}</span>}
                </h2>
                {section.items === null ? (
                  <Missing section={section.key} work={work} onOpenSettings={onOpenSettings} />
                ) : section.items.length === 0 ? (
                  <p className="work-empty">{section.empty}</p>
                ) : (
                  <ul className="work-list">
                    <AnimatePresence mode="popLayout">
                      {section.items.map((item) => (
                        <Row
                          key={item.url}
                          item={item}
                          index={visible.indexOf(item)}
                          selected={item.url === selected}
                          inToday={isIn(item, 'today')}
                          inBacklog={isIn(item, BACKLOG)}
                          onSelect={() => item.url !== selected && setSelected(item.url)}
                          onAdd={(target) => add(item, target)}
                          rowRef={(el) => {
                            if (el) rows.current.set(item.url, el)
                            else rows.current.delete(item.url)
                          }}
                        />
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
              </motion.section>
            ))}
          </AnimatePresence>
        </div>
      )}
    </>
  )
}

type RowProps = {
  item: WorkItem
  index: number
  selected: boolean
  inToday: boolean
  inBacklog: boolean
  onSelect: () => void
  onAdd: (target: Target) => void
  rowRef: (el: HTMLElement | null) => void
}

function Row({ item, index, selected, inToday, inBacklog, onSelect, onAdd, rowRef }: RowProps) {
  const icon = item.source === 'github' ? `github gh-${item.kind}` : 'linear'
  return (
    <motion.li
      ref={rowRef}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { ...spring, delay: Math.min(index, 12) * 0.025 } }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      className={selected ? 'work-row selected' : 'work-row'}
      onMouseMove={onSelect}
      onClick={() => openLink(item.url)}
    >
      {selected && <motion.span layoutId="work-highlight" className="work-highlight" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
      <span className={`state-icon ${icon}`} data-state={item.state} title={item.status ?? undefined} />
      <span className="work-main">
        <span className="work-title">{item.title}</span>
        <span className="work-meta">
          <span>{item.ref}</span>
          {item.status && <span>{item.status}</span>}
          {item.state === 'draft' && <span>Draft</span>}
          <span>{ago(item.updated)}</span>
        </span>
      </span>
      <span className="work-side">
        <Action label="Today" hint="T" added={inToday} onClick={() => onAdd('today')} />
        <Action label="Backlog" hint="B" added={inBacklog} onClick={() => onAdd(BACKLOG)} />
      </span>
    </motion.li>
  )
}

/** Adds the row to a note; once it's there, a quiet tag says so instead. */
function Action({ label, hint, added, onClick }: { label: string; hint: string; added: boolean; onClick: () => void }) {
  if (added) return <span className="work-tag">In {label.toLowerCase()}</span>
  return (
    <span className="work-reveal">
      <span>
        <button
          className="work-action"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
        >
          {label}
          <kbd>{hint}</kbd>
        </button>
      </span>
    </span>
  )
}

function Missing({ section, work, onOpenSettings }: { section: Section['key']; work: AssignedWork; onOpenSettings: () => void }) {
  if (section === 'linear') {
    if (work.linearError) return <p className="work-empty error">{work.linearError}</p>
    return (
      <div className="work-note">
        <span>Connect Linear to see the issues assigned to you.</span>
        <button className="button" onClick={onOpenSettings}>
          Open Settings
        </button>
      </div>
    )
  }
  if (work.githubError) return <p className="work-empty error">{work.githubError}</p>
  return (
    <p className="work-empty">
      Run <code>gh auth login</code> in a terminal to see your reviews and issues.
    </p>
  )
}

function Skeleton() {
  return (
    <ul className="work-list">
      {[62, 44, 70, 52, 38].map((width, i) => (
        <li key={i} className="work-row">
          <span className="work-skel icon" />
          <span className="work-main">
            <span className="work-skel" style={{ width: `${width}%` }} />
            <span className="work-skel meta" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function sectionsFor(work: AssignedWork, filter: Filter): Section[] {
  const sections: Section[] = []
  if (filter !== 'linear') {
    const github = work.github
    if (github) sections.push({ key: 'review', title: 'Review requests', items: github.filter((i) => i.group === 'review'), empty: 'No reviews waiting on you' })
    sections.push({ key: 'github', title: 'GitHub', items: github?.filter((i) => i.group === 'assigned') ?? null, empty: 'Nothing assigned to you' })
  }
  if (filter !== 'github') {
    const linear = work.linear && [...work.linear].sort((a, b) => rank(a) - rank(b) || b.updated - a.updated)
    sections.push({ key: 'linear', title: 'Linear', items: linear, empty: 'Nothing assigned to you' })
  }
  return sections
}

function rank(item: WorkItem) {
  const index = LINEAR_ORDER.indexOf(item.state)
  return index < 0 ? LINEAR_ORDER.length : index
}

/** Whether a note already links to the item. Linear URLs end in a slug that can change, so match up to the identifier. */
function mentions(markdown: string, item: WorkItem) {
  const url = item.source === 'linear' ? item.url.replace(/(\/issue\/[^/]+).*$/, '$1') : item.url
  return new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(markdown)
}

/** "now", "5m", "3h", "2d", "6w", "4mo", "2y". */
function ago(ms: number) {
  const minutes = (Date.now() - ms) / 60_000
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.floor(hours)}h`
  const days = hours / 24
  if (days < 7) return `${Math.floor(days)}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}
