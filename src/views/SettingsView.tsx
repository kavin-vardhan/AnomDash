import { useState } from 'react'
import { FolderOpen, FolderCog, PlugZap, RefreshCw, Info, ChevronDown } from 'lucide-react'
import { useApp } from '../appStore'
import { useStore } from '../store'
import { backend } from '../backend'
import { Button } from '../components/ui'
import { reconnectNow } from '../connection'
import { refreshSessions } from '../appInit'

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <span className="card-icon">{icon}</span>
        <h2>{title}</h2>
      </header>
      <div className="card-body">{children}</div>
    </section>
  )
}

export function SettingsView() {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const discovery = useApp((s) => s.discovery)
  const conn = useStore((s) => s.conn)
  const [manualOpen, setManualOpen] = useState(!!settings?.manualToken)
  const [url, setUrl] = useState(settings?.manualUrl || 'ws://127.0.0.1:8077')
  const [token, setToken] = useState(settings?.manualToken || '')
  const [msg, setMsg] = useState('')

  const change = async () => {
    const p = await backend.pickFolder()
    if (!p) return
    const s = await backend.setCapturesRoot(p)
    setSettings(s)
    setMsg('Captures folder updated.')
    void refreshSessions()
  }

  const saveManual = async (useIt: boolean) => {
    const s = await backend.setManual(useIt ? url.trim() : '', useIt ? token.trim() : '')
    setSettings(s)
    setMsg(useIt ? 'Using the manual connection.' : 'Back to automatic connection.')
    reconnectNow()
  }

  const ep = discovery?.endpoint
  const connected = conn === 'connected'

  return (
    <div className="view view-settings">
      <header className="view-head">
        <div>
          <h1>Settings</h1>
          <p className="view-sub">Everything here is optional. The defaults work out of the box.</p>
        </div>
      </header>
      {msg && <div className="toast" role="status">{msg}</div>}
      <div className="settings-grid">
        <Card icon={<FolderCog size={18} />} title="Captures folder">
          <p className="card-text">New captures are saved here. The game writes straight into this folder.</p>
          <div className="path-box">{settings?.capturesRoot ?? '…'}</div>
          <div className="card-actions">
            <Button variant="secondary" icon={<FolderCog size={15} />} onClick={change}>Change…</Button>
            <Button variant="ghost" icon={<FolderOpen size={15} />} disabled={!settings?.capturesRoot} onClick={() => settings && backend.openPath(settings.capturesRoot)}>Open</Button>
          </div>
        </Card>

        <Card icon={<PlugZap size={18} />} title="Game connection">
          <dl className="kv">
            <dt>Status</dt>
            <dd>{connected ? 'Connected' : conn === 'connecting' || conn === 'authenticating' ? 'Connecting…' : 'Not connected'}</dd>
            <dt>Game</dt>
            <dd>{ep ? `${ep.project_name} (${ep.kind === 'editor' ? 'Unreal Editor' : 'game build'})` : 'Not found yet'}</dd>
            <dt>Process</dt>
            <dd>{ep ? `${ep.process_name} · PID ${ep.pid}` : '—'}</dd>
            <dt>Access key</dt>
            <dd>{settings?.manualToken ? 'Entered manually' : ep?.token ? 'Read automatically from the game’s log' : '—'}</dd>
          </dl>
          {discovery?.detail ? <p className="card-text muted">{discovery.detail}</p> : null}
          <div className="card-actions">
            <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => reconnectNow()}>Reconnect</Button>
          </div>
          <div className={`advanced${manualOpen ? ' is-open' : ''}`}>
            <button className="advanced-toggle" aria-expanded={manualOpen} onClick={() => setManualOpen((v) => !v)}>
              <span>Connect manually</span>
              <ChevronDown size={16} />
            </button>
            {manualOpen && (
              <div className="advanced-body">
                <p className="card-text muted">Only needed if automatic connection can’t find your game. The key is printed in the game’s log after <code>IAI.Server.Start</code>.</p>
                <div className="field-label">Address</div>
                <input className="input" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
                <div className="field-label">Access key</div>
                <input className="input mono" value={token} spellCheck={false} placeholder="Paste the key" onChange={(e) => setToken(e.target.value)} />
                <div className="card-actions">
                  <Button variant="primary" disabled={!token.trim()} onClick={() => saveManual(true)}>Use this connection</Button>
                  {settings?.manualToken ? <Button variant="ghost" onClick={() => saveManual(false)}>Back to automatic</Button> : null}
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card icon={<Info size={18} />} title="About">
          <dl className="kv">
            <dt>Version</dt>
            <dd>{settings?.version ?? '—'}</dd>
            <dt>Video</dt>
            <dd>Encoded on this PC with Windows’ built-in H.264 encoder</dd>
            <dt>Target masks</dt>
            <dd>Recorded during every capture, released when you generate them</dd>
          </dl>
        </Card>
      </div>
    </div>
  )
}
