import { AnimatePresence, motion } from 'motion/react'
import type { NoteSummary } from '../lib/api'
import { AGENT, ASSIGNED, dayId, isDay, shortLabel } from '../lib/dates'

type Props = {
  ids: string[]
  notes: Map<string, NoteSummary>
  current: string
  /** How much is assigned to you, once known. */
  assignedCount: number | null
  /** The agent is answering, or has a plan waiting to be applied. */
  agentState: 'thinking' | 'waiting' | null
  onSelect: (id: string) => void
}

export function Sidebar({ ids, notes, current, assignedCount, agentState, onSelect }: Props) {
  const today = dayId()
  return (
    <nav className="sidebar">
      <div className="brand" data-tauri-drag-region>daybook</div>
      <ul className="days">
        <AnimatePresence initial={false}>
          {ids.map((id, index) => {
            const note = notes.get(id)
            const active = id === current
            const allDone = note && note.open === 0 && note.done + note.moved > 0
            return (
              <motion.li
                key={id}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0, transition: { delay: Math.min(index, 12) * 0.025 } }}
                exit={{ opacity: 0, x: -8 }}
                className={id === AGENT ? 'pinned' : afterUpcoming(ids, index, today) ? 'past' : undefined}
              >
                <button className={active ? 'day active' : 'day'} onClick={() => onSelect(id)} title={id === ASSIGNED ? 'Assigned (⌘J)' : id === AGENT ? 'Agent (⌘L)' : undefined}>
                  {active && (
                    <motion.span layoutId="day-highlight" className="day-highlight" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
                  )}
                  <span className="day-label">
                    {id === today && <span className="today-dot" />}
                    {shortLabel(id)}
                  </span>
                  <span className="day-count">
                    {id === AGENT ? (
                      agentState && <span className={`agent-dot ${agentState}`} />
                    ) : id === ASSIGNED ? (
                      assignedCount || ''
                    ) : allDone ? (
                      <Check />
                    ) : note?.open ? (
                      note.open
                    ) : (
                      ''
                    )}
                  </span>
                </button>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      <div className="hints">
        <span><kbd>⌘K</kbd> capture</span>
        <span><kbd>⌘L</kbd> agent</span>
        <span><kbd>⌥↑↓</kbd> days</span>
        <span><kbd>⌘/</kbd> source</span>
      </div>
    </nav>
  )
}

/** The first day before today, when days ahead are listed above it. */
function afterUpcoming(ids: string[], index: number, today: string) {
  const previous = ids[index - 1]
  return isDay(ids[index]) && ids[index] < today && !!previous && isDay(previous) && previous > today
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-label="All done">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
