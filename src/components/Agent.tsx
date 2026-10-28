import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { agentWarm, linkInfo, type AgentChange, type AgentSettings, type LinkInfo as LiveInfo, type ProviderId } from '../lib/api'
import type { AgentThread, Assistant, Status } from '../lib/agent'
import { AGENT, BACKLOG, dayId, shortLabel, titleFor } from '../lib/dates'
import { classify, isEnrichable } from '../lib/links'
import { openLink } from '../lib/native'

const PROVIDERS: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', openrouter: 'OpenRouter' }

function providerLabel(settings: AgentSettings | null) {
  if (!settings) return 'Claude'
  const { prefs } = settings
  const model = { claude: prefs.claudeModel, codex: prefs.codexModel, openrouter: prefs.openrouterModel }[prefs.provider]
  const short = model.split('/').at(-1)?.replace(/^claude-/, '') ?? ''
  const pretty = short ? short.charAt(0).toUpperCase() + short.slice(1) : ''
  return pretty ? `${PROVIDERS[prefs.provider]} · ${pretty}` : PROVIDERS[prefs.provider]
}

const SUGGESTIONS = [
  'Add the reviews waiting on me to today',
  'Move whatever’s left today to tomorrow',
  'What’s still open this week?',
]

const spring = { type: 'spring', stiffness: 420, damping: 36 } as const

type Props = {
  agent: AgentThread
  settings: AgentSettings | null
  /** True while a dialog is open over the page, so its keys are left alone. */
  paused: boolean
  onOpenSettings: () => void
  onOpenNote: (id: string) => void
}

export function Agent({ agent, settings, paused, onOpenSettings, onOpenNote }: Props) {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const heading = titleFor(AGENT)
  const { thread, pending } = agent
  const provider = settings?.providers.find((p) => p.id === settings.prefs.provider)
  const latest = [...thread].reverse().find((e): e is Assistant => e.role === 'assistant')
  const waiting = latest?.status === 'proposed' && latest.changes.length > 0 ? latest : null

  useEffect(() => {
    agentWarm()
    input.current?.focus()
  }, [settings?.prefs])

  // Keep the newest message in view, above the message box, as the thread grows.
  useEffect(() => {
    const scroller = end.current?.closest('.scroll')
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }, [thread.length, pending])

  useEffect(() => {
    if (paused) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && pending) {
        event.preventDefault()
        agent.stop()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && waiting) {
        event.preventDefault()
        agent.apply(waiting)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function send() {
    if (!draft.trim() || pending) return
    agent.send(draft)
    setDraft('')
  }

  function suggest(text: string) {
    setDraft(text)
    input.current?.focus()
  }

  return (
    <div className="agent">
      <header className="page-header work-header">
        <div>
          <h1>{heading.title}</h1>
          <div className="page-meta">
            <span>{heading.subtitle}</span>
          </div>
        </div>
        <AnimatePresence>
          {thread.length > 0 && (
            <motion.button
              className="button quiet agent-new"
              onClick={() => {
                agent.reset()
                input.current?.focus()
              }}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
            >
              New chat
            </motion.button>
          )}
        </AnimatePresence>
      </header>

      <div className="agent-thread">
        <AnimatePresence initial={false}>
          {thread.length === 0 && !pending && (
            <motion.div key="welcome" className="agent-welcome" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}>
              <p>
                Paste links from Slack or GitHub, brain-dump your week, or ask what's left. It reads your notes and what's assigned to you, then
                suggests changes you can look over before anything is written.
              </p>
              <div className="agent-suggestions">
                {SUGGESTIONS.map((text, i) => (
                  <motion.button
                    key={text}
                    className="agent-suggestion"
                    onClick={() => suggest(text)}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0, transition: { ...spring, delay: 0.05 + i * 0.04 } }}
                  >
                    {text}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
          {thread.map((entry) => (
            <motion.div
              key={entry.id}
              layout="position"
              className={`agent-entry ${entry.role}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={spring}
            >
              {entry.role === 'user' ? (
                <div className="agent-bubble">
                  <Inline text={entry.text} />
                </div>
              ) : entry.role === 'error' ? (
                <div className="agent-error">
                  <span>{entry.text}</span>
                  <button className="button quiet" onClick={() => agent.send(entry.retry)} disabled={pending}>
                    Try again
                  </button>
                </div>
              ) : (
                <>
                  {entry.reply && <p className="agent-reply">{entry.reply}</p>}
                  {entry.changes.length > 0 && <Plan entry={entry} agent={agent} onOpenNote={onOpenNote} />}
                </>
              )}
            </motion.div>
          ))}
          {pending && (
            <motion.div key="thinking" className="agent-entry assistant" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <Thinking name={settings ? PROVIDERS[settings.prefs.provider] : 'Claude'} />
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={end} />
      </div>

      <div className="agent-composer">
        <AnimatePresence>
          {provider && !provider.ready && (
            <motion.div className="agent-notice" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <span>{provider.detail}</span>
              <button className="button quiet" onClick={onOpenSettings}>
                Settings
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="composer">
          <textarea
            ref={input}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={thread.length ? 'Reply, or adjust the plan…' : 'What’s on your plate?'}
            spellCheck
          />
          <div className="composer-bar">
            <button className="composer-provider" onClick={onOpenSettings} title="Choose the model in Settings">
              <span className={`provider-dot ${provider && !provider.ready ? 'off' : ''}`} />
              {providerLabel(settings)}
            </button>
            <span className="composer-keys">
              {waiting ? (
                <>
                  <kbd>⌘↵</kbd> apply
                </>
              ) : (
                <>
                  <kbd>⇧↵</kbd> new line
                </>
              )}
            </span>
            <button
              className={pending ? 'composer-send stop' : 'composer-send'}
              onClick={pending ? agent.stop : send}
              disabled={!pending && !draft.trim()}
              aria-label={pending ? 'Stop' : 'Send'}
              title={pending ? 'Stop (Esc)' : 'Send (↵)'}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.svg
                  key={pending ? 'stop' : 'send'}
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.12 }}
                >
                  {pending ? (
                    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                  ) : (
                    <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </motion.svg>
              </AnimatePresence>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const THINKING = ['Reading your notes', 'Thinking', 'Still thinking']

function Thinking({ name }: { name: string }) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    const timers = [window.setTimeout(() => setStep(1), 1800), window.setTimeout(() => setStep(2), 9000)]
    return () => timers.forEach(window.clearTimeout)
  }, [])
  return (
    <div className="agent-thinking" aria-live="polite">
      <span className="thinking-dots">
        <span />
        <span />
        <span />
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={step} className="thinking-text" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }}>
          {step === 0 ? THINKING[0] : `${name} is ${THINKING[step].toLowerCase()}`}…
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

/** The note a change lands in, or is about. */
function noteOf(change: AgentChange) {
  return change.action === 'add' || change.action === 'move' ? change.note : (change.task?.note ?? change.note)
}

/** Today first, then the days ahead, then earlier days, then the backlog. */
function order(id: string) {
  const today = dayId()
  if (id === today) return '0'
  if (id === BACKLOG) return '3'
  return id > today ? `1${id}` : `2${id}`
}

function Plan({ entry, agent, onOpenNote }: { entry: Assistant; agent: AgentThread; onOpenNote: (id: string) => void }) {
  const groups = new Map<string, number[]>()
  entry.changes.forEach((change, index) => {
    const id = noteOf(change)
    groups.set(id, [...(groups.get(id) ?? []), index])
  })
  const ids = [...groups.keys()].sort((a, b) => order(a).localeCompare(order(b)))
  const live = entry.status === 'proposed'
  const included = entry.changes.length - entry.skipped.length
  let row = 0

  return (
    <motion.div className={`plan ${entry.status}`} layout initial={{ opacity: 0, y: 8, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}>
      <div className="plan-body">
        {ids.map((id) => (
          <section key={id} className="plan-group">
            <h3>
              <button onClick={() => onOpenNote(id)} title={`Open ${shortLabel(id)}`}>
                {shortLabel(id)}
              </button>
            </h3>
            <ul>
              {groups.get(id)!.map((index) => (
                <Change
                  key={index}
                  change={entry.changes[index]}
                  delay={row++}
                  skipped={entry.skipped.includes(index)}
                  status={entry.status}
                  onToggle={live ? () => agent.toggle(entry, index) : undefined}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="plan-footer">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={entry.status} className="plan-footer-inner" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
            {entry.status === 'proposed' ? (
              <>
                <span className="plan-summary">{entry.note ?? (included ? `${included} change${included === 1 ? '' : 's'}` : 'Nothing selected')}</span>
                <span className="plan-actions">
                  <button className="button quiet" onClick={() => agent.discard(entry)}>
                    Discard
                  </button>
                  <button className="button primary" onClick={() => agent.apply(entry)} disabled={!included}>
                    Apply <kbd>⌘↵</kbd>
                  </button>
                </span>
              </>
            ) : entry.status === 'applied' ? (
              <>
                <span className="plan-summary done">
                  <Tick /> Applied
                </span>
                <button className="button quiet" onClick={() => agent.undo(entry)}>
                  Undo
                </button>
              </>
            ) : (
              <span className="plan-summary">{entry.note ?? { discarded: 'Discarded', replaced: 'Replaced by a newer plan', undone: 'Undone' }[entry.status]}</span>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

const VERBS = { add: 'Add', done: 'Tick off', move: 'Move', edit: 'Rewrite', remove: 'Remove' }

function Change({ change, delay, skipped, status, onToggle }: { change: AgentChange; delay: number; skipped: boolean; status: Status; onToggle?: () => void }) {
  const text = change.action === 'add' || change.action === 'edit' ? change.text : (change.task?.text ?? '')
  const applied = status === 'applied' && !skipped
  return (
    <motion.li
      className={['plan-row', change.action, skipped && 'skipped', applied && 'applied'].filter(Boolean).join(' ')}
      style={{ '--i': delay } as React.CSSProperties}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0, transition: { ...spring, delay: 0.04 + Math.min(delay, 10) * 0.035 } }}
    >
      <span className="plan-mark" aria-label={VERBS[change.action]} />
      <div className="plan-text">
        <span className="plan-line">
          <span className="plan-words">
            <Inline text={text} />
          </span>
          {change.action === 'move' && change.task && <span className="plan-tag">from {shortLabel(change.task.note)}</span>}
          {change.action !== 'add' && change.action !== 'move' && <span className="plan-tag">{VERBS[change.action]}</span>}
        </span>
        {change.action === 'edit' && change.task && (
          <span className="plan-was">
            <Inline text={change.task.text} />
          </span>
        )}
        {change.subtasks.length > 0 && (
          <ul className="plan-subtasks">
            {change.subtasks.map((sub, i) => (
              <li key={i}>
                <span className="plan-mark small" />
                <Inline text={sub} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {onToggle && (
        <button className="plan-skip" onClick={onToggle} title={skipped ? 'Put it back' : 'Leave this out'} aria-label={skipped ? 'Put it back' : 'Leave this out'}>
          {skipped ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          )}
        </button>
      )}
    </motion.li>
  )
}

function Tick() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const INLINE = /\[((?:\\.|[^\]\\])+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+)|`([^`]+)`|\*\*([^*]+)\*\*/g

/** A task's markdown on one line: links as the same chips the notes use, plus code and bold. */
function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const [whole, label, href, bare, code, bold] = match
    parts.push(text.slice(last, match.index))
    const key = match.index
    if (href) parts.push(<Chip key={key} href={href} label={label.replace(/\\(.)/g, '$1')} />)
    else if (bare) parts.push(<Chip key={key} href={bare.replace(/[.,;:!?]+$/, '')} />)
    else if (code) parts.push(<code key={key}>{code}</code>)
    else if (bold) parts.push(<strong key={key}>{bold}</strong>)
    last = match.index + whole.length
    if (bare) last -= bare.length - bare.replace(/[.,;:!?]+$/, '').length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

function Chip({ href, label }: { href: string; label?: string }) {
  const info = classify(href)
  const [live, setLive] = useState<LiveInfo | null>(null)
  useEffect(() => {
    if (!isEnrichable(href)) return
    let cancelled = false
    linkInfo(href).then((next) => !cancelled && setLive(next))
    return () => {
      cancelled = true
    }
  }, [href])
  const kind = info.kind === 'github' ? `chip-github gh-${info.type}` : `chip-${info.kind}`
  const shown = label && label !== href && label !== info.ref ? label : (live?.title ?? info.ref)
  return (
    <a
      className={`chip ${kind}`}
      data-ref={info.ref}
      title={href}
      onClick={(e) => {
        e.stopPropagation()
        openLink(href)
      }}
    >
      <span className="chip-text" data-state={live?.state} data-bare={shown === info.ref ? '' : undefined}>
        {shown}
      </span>
    </a>
  )
}
