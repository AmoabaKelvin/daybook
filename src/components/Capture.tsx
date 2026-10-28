import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { BACKLOG } from '../lib/dates'
import { classify } from '../lib/links'

type Target = 'today' | typeof BACKLOG

type CardProps = {
  onClose: () => void
  onSubmit: (text: string, subtasks: string[], target: Target) => Promise<void>
  /** ⌘↵: hand what was typed to the agent instead. */
  onAsk?: (text: string) => void
}

export function Capture({ open, onClose, onSubmit, onAsk }: CardProps & { open: boolean }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="capture-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <CaptureCard onClose={onClose} onSubmit={onSubmit} onAsk={onAsk} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

let nextRow = 0
type Row = { key: number; text: string }
const row = (text = ''): Row => ({ key: nextRow++, text })

/**
 * The capture box, shown by the ⌘K dialog and by the quick capture panel.
 * The entry is rows[0]; every row after it is a sub-task.
 */
export function CaptureCard({ onClose, onSubmit, onAsk }: CardProps) {
  const [rows, setRows] = useState(() => [row()])
  const [focused, setFocused] = useState(0)
  const [target, setTarget] = useState<Target>('today')
  const [busy, setBusy] = useState(false)
  const inputs = useRef(new Map<number, HTMLInputElement>())

  useEffect(() => inputs.current.get(rows[focused]?.key)?.focus(), [rows, focused])

  async function submit() {
    const [entry, ...subtasks] = rows.map((r) => r.text)
    if (!entry.trim() || busy) return
    setBusy(true)
    await onSubmit(entry, subtasks, target)
    onClose()
  }

  function ask() {
    const [entry, ...subtasks] = rows.map((r) => r.text.trim())
    if (!entry || !onAsk) return
    const steps = subtasks.filter(Boolean)
    onAsk(steps.length ? `${entry}\n${steps.map((s) => `- ${s}`).join('\n')}` : entry)
  }

  function edit(index: number, text: string) {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, text } : r)))
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>, index: number) {
    const { key, shiftKey } = event
    if (key === 'Escape') onClose()
    else if (key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      ask()
    } else if (key === 'Enter' && shiftKey) {
      event.preventDefault()
      setRows((rs) => [...rs.slice(0, index + 1), row(), ...rs.slice(index + 1)])
      setFocused(index + 1)
    } else if (key === 'Enter') submit()
    else if (key === 'Backspace' && index > 0 && !rows[index].text) {
      event.preventDefault()
      setRows((rs) => rs.filter((_, i) => i !== index))
      setFocused(index - 1)
    } else if ((key === 'ArrowUp' && index > 0) || (key === 'ArrowDown' && index < rows.length - 1)) {
      event.preventDefault()
      setFocused(index + (key === 'ArrowUp' ? -1 : 1))
    } else if (key === 'Tab') {
      event.preventDefault()
      setTarget((t) => (t === 'today' ? BACKLOG : 'today'))
    }
  }

  const previewText = rows[focused]?.text ?? ''

  return (
    <motion.div
      className="capture"
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="capture-rows">
        <AnimatePresence initial={false}>
          {rows.map((r, index) => (
            <motion.div
              key={r.key}
              className={index === 0 ? 'capture-row' : 'capture-row sub'}
              initial={index === 0 ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ type: 'spring', stiffness: 520, damping: 40 }}
            >
              <span className={busy && index === 0 ? 'capture-box busy' : 'capture-box'} />
              <input
                ref={(el) => {
                  if (el) inputs.current.set(r.key, el)
                  else inputs.current.delete(r.key)
                }}
                value={r.text}
                onChange={(e) => edit(index, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, index)}
                onFocus={() => setFocused(index)}
                placeholder={index === 0 ? 'Something to do, or paste a link…' : 'Sub-task'}
                spellCheck
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {/https?:\/\//.test(previewText) && (
          <motion.div className="capture-preview" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div className={focused === 0 ? 'prose capture-preview-inner' : 'prose capture-preview-inner sub'}>
              <Preview text={previewText} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="capture-footer">
        <div className="segmented" role="radiogroup">
          {(['today', BACKLOG] as const).map((t) => (
            <button key={t} role="radio" aria-checked={target === t} className={target === t ? 'on' : ''} onClick={() => setTarget(t)}>
              {target === t && <motion.span layoutId="capture-target" className="segmented-pill" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
              <span>{t === 'today' ? 'Today' : 'Backlog'}</span>
            </button>
          ))}
        </div>
        <span className="capture-keys">
          <kbd>⇧↵</kbd> sub-task <kbd>tab</kbd> switch {onAsk && <><kbd>⌘↵</kbd> agent </>}<kbd>↵</kbd> add
        </span>
      </div>
    </motion.div>
  )
}

function Preview({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>()]+)/g)
  return (
    <p>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part
        const info = classify(part)
        const kind = info.kind === 'github' ? `chip-github gh-${info.type}` : `chip-${info.kind}`
        return (
          <a key={i} className={`chip ${kind}`} data-ref={info.ref}>
            <span className="chip-text" data-bare="">{info.ref}</span>
          </a>
        )
      })}
    </p>
  )
}
