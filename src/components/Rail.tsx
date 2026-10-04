import { Aperture, LibraryBig, Settings2 } from 'lucide-react'
import { useApp, type View } from '../appStore'
import { useStore } from '../store'

function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <path d="M3 9V5a2 2 0 0 1 2-2h4M19 3h4a2 2 0 0 1 2 2v4M25 19v4a2 2 0 0 1-2 2h-4M9 25H5a2 2 0 0 1-2-2v-4" fill="none" stroke="#C9D2FF" strokeWidth="2" strokeLinecap="round" />
      <rect x="9" y="9" width="10" height="10" rx="2" fill="#4B4FE0" />
      <rect x="15.5" y="9" width="3.5" height="3.5" fill="#D6338A" />
    </svg>
  )
}

const NAV: Array<{ key: View; label: string; icon: typeof Aperture }> = [
  { key: 'capture', label: 'Capture', icon: Aperture },
  { key: 'library', label: 'Library', icon: LibraryBig },
  { key: 'settings', label: 'Settings', icon: Settings2 },
]

function ConnectionBlock() {
  const conn = useStore((s) => s.conn)
  const stalled = useStore((s) => s.stalled)
  const cap = useStore((s) => s.snapshot?.capture)
  const discovery = useApp((s) => s.discovery)
  const project = discovery?.endpoint?.project_name
  const kind = discovery?.endpoint?.kind === 'editor' ? 'Editor' : discovery?.endpoint ? 'Game' : ''

  let tone = 'off'
  let title = 'Looking for the game'
  let sub = 'Start your game to connect'
  if (conn === 'connected' && cap?.running) {
    tone = 'rec'
    title = 'Recording'
    sub = cap.maxFrames > 0 ? `${cap.framesWritten} of ${cap.maxFrames} frames` : `${cap.framesWritten} frames`
  } else if (conn === 'connected' && stalled) {
    tone = 'warn'
    title = 'Game not responding'
    sub = 'Waiting for updates…'
  } else if (conn === 'connected') {
    tone = 'ok'
    title = 'Connected'
    sub = project ? `${project}${kind ? ` · ${kind}` : ''}` : 'Game is ready'
  } else if (conn === 'connecting' || conn === 'authenticating') {
    tone = 'warn'
    title = 'Connecting…'
    sub = project ?? 'Game found'
  } else if (conn === 'auth_failed') {
    tone = 'warn'
    title = 'Reconnecting'
    sub = 'Refreshing the game’s access key'
  } else if (discovery?.status === 'no_token') {
    tone = 'warn'
    title = 'Game found'
    sub = 'Waiting for its control server'
  }

  return (
    <div className={`rail-conn tone-${tone}`} aria-live="polite">
      <span className="rail-conn-dot" />
      <span className="rail-conn-text">
        <span className="rail-conn-title">{title}</span>
        <span className="rail-conn-sub">{sub}</span>
      </span>
    </div>
  )
}

export function Rail() {
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const count = useApp((s) => s.sessions.length)

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-brand">
        <Mark />
        <span className="rail-brand-text">
          <span className="rail-brand-name">Anomaly Dashboard</span>
          <span className="rail-brand-sub">Capture · Generate</span>
        </span>
      </div>
      <ul className="rail-nav">
        {NAV.map((n) => {
          const Icon = n.icon
          return (
            <li key={n.key}>
              <button className={view === n.key ? 'on' : ''} aria-current={view === n.key ? 'page' : undefined} onClick={() => setView(n.key)}>
                <Icon size={18} strokeWidth={1.8} />
                <span>{n.label}</span>
                {n.key === 'library' && count > 0 ? <span className="rail-count">{count}</span> : null}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="rail-foot">
        <ConnectionBlock />
      </div>
    </nav>
  )
}
