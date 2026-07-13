import { useState } from 'react'
import { useStore } from '../store'
import { client } from '../transport/AnomalyClient'
import { BAKED_TOKEN } from '../config'

export function ConnectScreen() {
  const conn = useStore((s) => s.conn)
  const wsUrl0 = useStore((s) => s.wsUrl)
  const token0 = useStore((s) => s.token)
  const lastError = useStore((s) => s.lastError)
  const [url, setUrl] = useState(wsUrl0)
  const [token, setToken] = useState(BAKED_TOKEN || token0)
  const busy = conn === 'connecting' || conn === 'authenticating'

  const connect = () => {
    useStore.getState().setCreds(url.trim(), token.trim())
    client.connect(url.trim(), token.trim())
  }

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <h1>Anomaly Dashboard</h1>
        <label>
          Server URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </label>
        <label>
          Token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="auto-filled in a client build; else paste from the Output Log"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter' && token.trim() && !busy) connect() }}
          />
        </label>
        <button disabled={busy || !token.trim()} onClick={connect}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <div className={`status ${conn === 'connected' ? 'ok' : busy ? 'wait' : 'bad'}`}>
          {conn}{lastError ? ` — ${lastError}` : ''}
        </div>
        <p className="hint">
          Client build: the token is baked in (<code>VITE_CONTROL_TOKEN</code>) and connects automatically.
          In-editor (PIE): run <code>IAI.Server.Start</code> and copy the token from the Output Log.
        </p>
      </div>
    </div>
  )
}
