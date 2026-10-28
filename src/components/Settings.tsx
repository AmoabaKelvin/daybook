import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import {
  agentSettings,
  clearLinearKey,
  clearOpenRouterKey,
  connectOpenRouter,
  getSettings,
  installCli,
  revealNotes,
  setAgentPrefs,
  setCaptureShortcut,
  setLinearKey,
  setOpenRouterKey,
  type AgentPrefs,
  type AgentSettings,
  type ProviderId,
  type Settings as SettingsData,
} from '../lib/api'
import { isNative, openLink } from '../lib/native'

type Props = {
  open: boolean
  onClose: () => void
  onLinksChanged: () => void
}

const LINEAR_KEYS_URL = 'https://linear.app/settings/account/security'

export function Settings({ open, onClose, onLinksChanged }: Props) {
  return <AnimatePresence>{open && <SettingsSheet onClose={onClose} onLinksChanged={onLinksChanged} />}</AnimatePresence>
}

function SettingsSheet({ onClose, onLinksChanged }: Omit<Props, 'open'>) {
  const [settings, setSettings] = useState<SettingsData | null>(null)

  useEffect(() => {
    getSettings().then(setSettings)
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <motion.div className="sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.div
        className="sheet"
        role="dialog"
        aria-label="Settings"
        initial={{ opacity: 0, y: -12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 520, damping: 34 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="sheet-header">
          <h2>Settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        {!isNative ? (
          <p className="sheet-note">Settings live in the Mac app.</p>
        ) : (
          <div className="sheet-body">
            <Linear settings={settings} onChange={(next) => { setSettings(next); onLinksChanged() }} />
            <Row icon="github" title="GitHub" loading={!settings}>
              {settings?.githubLogin ? (
                <Status ok>
                  Signed in as <strong>@{settings.githubLogin}</strong> through <code>gh</code>
                </Status>
              ) : (
                <Status>
                  Not signed in. Run <code>gh auth login</code> in a terminal.
                </Status>
              )}
            </Row>
            <QuickCapture settings={settings} onChange={setSettings} />
            <AgentRow />
            <CommandLine settings={settings} onChange={setSettings} />
            <Row icon="folder" title="Notes" loading={!settings}>
              <div className="row-inline">
                <code>{settings?.notesDir}</code>
                <button className="button" onClick={revealNotes}>Show in Finder</button>
              </div>
            </Row>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

function Linear({ settings, onChange }: { settings: SettingsData | null; onChange: (s: SettingsData) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    if (!key.trim() || !settings) return
    setBusy(true)
    setError(null)
    try {
      const linear = await setLinearKey(key)
      setKey('')
      onChange({ ...settings, linear, linearError: null })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!settings) return
    await clearLinearKey()
    onChange({ ...settings, linear: null, linearError: null })
  }

  const message = error ?? settings?.linearError
  return (
    <Row icon="linear" title="Linear" loading={!settings}>
      <AnimatePresence mode="wait" initial={false}>
        {settings?.linear ? (
          <motion.div key="on" className="row-inline" {...swap}>
            <Status ok>
              Connected as <strong>{settings.linear.name}</strong> · {settings.linear.workspace}
            </Status>
            <button className="button quiet" onClick={disconnect}>Disconnect</button>
          </motion.div>
        ) : (
          <motion.div key="off" {...swap}>
            <form
              className="row-inline"
              onSubmit={(e) => {
                e.preventDefault()
                connect()
              }}
            >
              <input
                className="field"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="lin_api_…"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="button primary" disabled={busy || !key.trim()}>
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </form>
            <AnimatePresence>
              {message && (
                <motion.p className="row-error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                  {message}
                </motion.p>
              )}
            </AnimatePresence>
            <p className="row-help">
              Make a personal API key in{' '}
              <a onClick={() => openLink(LINEAR_KEYS_URL)}>Linear → Settings → Security &amp; access</a>. Read-only is enough. It's kept in
              your Keychain.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </Row>
  )
}

function QuickCapture({ settings, onChange }: { settings: SettingsData | null; onChange: (s: SettingsData) => void }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shortcut = settings?.captureShortcut.shortcut

  const save = useCallback(
    async (next: string | null) => {
      if (!settings) return
      setRecording(false)
      try {
        await setCaptureShortcut(next)
        onChange({ ...settings, captureShortcut: { shortcut: next, error: null } })
        setError(null)
      } catch (e) {
        setError(String(e))
      }
    },
    [settings, onChange],
  )

  // While recording, the next key combination becomes the shortcut. Esc cancels.
  useEffect(() => {
    if (!recording) return
    function onKey(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') setRecording(false)
      else {
        const accelerator = toAccelerator(event)
        if (accelerator) save(accelerator)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, save])

  const message = error ?? settings?.captureShortcut.error
  return (
    <Row icon="command" title="Quick capture" loading={!settings}>
      <div className="row-inline">
        <Status ok={!!shortcut && !message}>{shortcut ? 'Opens the capture box over any app' : 'Off'}</Status>
        <span className="row-actions">
          {shortcut && !recording && (
            <button className="button quiet" onClick={() => save(null)}>
              Turn off
            </button>
          )}
          <button className={recording ? 'button shortcut recording' : 'button shortcut'} onClick={() => setRecording((r) => !r)}>
            {recording ? 'Type a shortcut…' : shortcut ? shortcutKeys(shortcut).map((key) => <kbd key={key}>{key}</kbd>) : 'Set shortcut'}
          </button>
        </span>
      </div>
      <AnimatePresence>
        {message && (
          <motion.p className="row-error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {message}
          </motion.p>
        )}
      </AnimatePresence>
      <p className="row-help">Add a task from Slack, the browser, anywhere, without switching apps. Esc closes it.</p>
    </Row>
  )
}

const MODIFIERS = ['Meta', 'Alt', 'Control', 'Shift']

/** A keydown as a global shortcut accelerator like "Alt+Space", if it has a modifier (or is an F-key). */
function toAccelerator(event: KeyboardEvent) {
  if (MODIFIERS.includes(event.key)) return null
  const key = event.code.replace(/^(Key|Digit)/, '')
  const mods = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Cmd'].filter(Boolean)
  if (!mods.length && !/^F\d+$/.test(key)) return null
  return [...mods, key].join('+')
}

const KEY_SYMBOLS: Record<string, string> = {
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Cmd: '⌘',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
}

function shortcutKeys(accelerator: string) {
  return accelerator.split('+').map((part) => KEY_SYMBOLS[part] ?? part)
}

function CommandLine({ settings, onChange }: { settings: SettingsData | null; onChange: (s: SettingsData) => void }) {
  const [error, setError] = useState<string | null>(null)

  async function install() {
    if (!settings) return
    try {
      await installCli()
      onChange({ ...settings, cliInstalled: true })
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <Row icon="terminal" title="Command line" loading={!settings}>
      <div className="row-inline">
        {settings?.cliInstalled ? (
          <Status ok>
            <code>daybook</code> command is installed at <code>{settings.cliPath}</code>
          </Status>
        ) : (
          <>
            <Status>
              Install the <code>daybook</code> command so agents can add and tick off tasks.
            </Status>
            <button className="button" onClick={install}>Install</button>
          </>
        )}
      </div>
      {error && <p className="row-error">{error}</p>}
      <p className="row-help">
        Agents like Claude Code can run <code>daybook help</code> to learn the rest. Changes they make show up here right away.
      </p>
    </Row>
  )
}

const PROVIDERS: [ProviderId, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['openrouter', 'OpenRouter'],
]
const CLAUDE_MODELS: [string, string][] = [
  ['haiku', 'Haiku'],
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
]
const MODEL_FIELD = { claude: 'claudeModel', codex: 'codexModel', openrouter: 'openrouterModel' } as const

function AgentRow() {
  const [agent, setAgent] = useState<AgentSettings | null>(null)
  // The model being typed, until it's saved.
  const [model, setModel] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'connect' | 'key' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => agentSettings().then(setAgent), [])
  useEffect(() => {
    load()
  }, [load])

  const prefs = agent?.prefs
  const provider = prefs?.provider ?? 'claude'
  const status = agent?.providers.find((p) => p.id === provider)

  async function save(next: AgentPrefs) {
    if (!agent) return
    setAgent({ ...agent, prefs: next })
    setError(null)
    await setAgentPrefs(next).catch((e) => setError(String(e)))
  }

  function saveModel() {
    if (prefs && model !== null && model.trim() !== prefs[MODEL_FIELD[provider]]) save({ ...prefs, [MODEL_FIELD[provider]]: model.trim() })
    setModel(null)
  }

  async function connect(run: () => Promise<void>, kind: 'connect' | 'key') {
    setBusy(kind)
    setError(null)
    try {
      await run()
      setKey('')
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function disconnect() {
    await clearOpenRouterKey()
    load()
  }

  return (
    <Row icon="sparkle" title="Agent" loading={!agent}>
      <div className="row-inline">
        <div className="segmented" role="radiogroup" aria-label="Provider">
          {PROVIDERS.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={provider === id} className={provider === id ? 'on' : ''} onClick={() => {
                if (!prefs) return
                setModel(null)
                save({ ...prefs, provider: id })
              }}>
              {provider === id && <motion.span layoutId="agent-provider" className="segmented-pill" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
              <span>{label}</span>
            </button>
          ))}
        </div>
        {provider === 'claude' && prefs && (
          <div className="segmented" role="radiogroup" aria-label="Model">
            {CLAUDE_MODELS.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={prefs.claudeModel === id} className={prefs.claudeModel === id ? 'on' : ''} onClick={() => save({ ...prefs, claudeModel: id })}>
                {prefs.claudeModel === id && <motion.span layoutId="agent-model" className="segmented-pill" transition={{ type: 'spring', stiffness: 600, damping: 40 }} />}
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={provider} className="agent-settings" {...swap}>
          <div className="row-inline">
            {status && <Status ok={status.ready}>{status.detail}</Status>}
            {provider === 'openrouter' && status?.ready && (
              <button className="button quiet" onClick={disconnect}>
                Disconnect
              </button>
            )}
            {provider === 'openrouter' && !status?.ready && (
              <button className="button primary" onClick={() => connect(connectOpenRouter, 'connect')} disabled={!!busy}>
                {busy === 'connect' ? 'Waiting for the browser…' : 'Connect'}
              </button>
            )}
          </div>
          {provider !== 'claude' && (
            <form
              className="row-inline"
              onSubmit={(e) => {
                e.preventDefault()
                saveModel()
              }}
            >
              <input
                className="field"
                value={model ?? prefs?.[MODEL_FIELD[provider]] ?? ''}
                onChange={(e) => setModel(e.target.value)}
                onBlur={saveModel}
                placeholder={provider === 'codex' ? 'Codex’s default model' : 'anthropic/claude-haiku-5.5'}
                spellCheck={false}
                autoComplete="off"
                aria-label="Model"
              />
            </form>
          )}
          {provider === 'openrouter' && !status?.ready && (
            <form
              className="row-inline"
              onSubmit={(e) => {
                e.preventDefault()
                if (key.trim()) connect(() => setOpenRouterKey(key.trim()), 'key')
              }}
            >
              <input
                className="field"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Or paste a key: sk-or-…"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="button" disabled={!!busy || !key.trim()}>
                {busy === 'key' ? 'Checking…' : 'Save'}
              </button>
            </form>
          )}
        </motion.div>
      </AnimatePresence>
      <AnimatePresence>
        {error && (
          <motion.p className="row-error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      <p className="row-help">
        {provider === 'openrouter'
          ? 'Pay as you go with any model that supports structured output. The key is kept in your Keychain.'
          : `Uses your own ${provider === 'claude' ? 'Claude Code' : 'Codex'} sign-in on this Mac.`}{' '}
        Nothing is written until you apply it. <kbd>⌘L</kbd> opens it.
      </p>
    </Row>
  )
}

const swap = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.18 },
}

function Row({ icon, title, loading, children }: { icon: string; title: string; loading: boolean; children: React.ReactNode }) {
  return (
    <section className="row">
      <span className={`row-icon icon-${icon}`} />
      <div className="row-main">
        <h3>{title}</h3>
        {loading ? <div className="row-skeleton" /> : children}
      </div>
    </section>
  )
}

function Status({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <span className={ok ? 'status ok' : 'status'}>
      {ok && (
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span>{children}</span>
    </span>
  )
}
