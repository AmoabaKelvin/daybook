import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { clearLinearKey, getSettings, installCli, revealNotes, setLinearKey, type Settings as SettingsData } from '../lib/api'
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
            <Agents settings={settings} onChange={setSettings} />
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

function Agents({ settings, onChange }: { settings: SettingsData | null; onChange: (s: SettingsData) => void }) {
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
    <Row icon="terminal" title="Agents" loading={!settings}>
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
