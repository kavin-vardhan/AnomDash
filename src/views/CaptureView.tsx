import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { useStore } from '../store'
import { fileUrl } from '../backend'
import { useApp } from '../appStore'
import { LiveView } from '../components/LiveView'
import { SetupPanel } from '../components/SetupPanel'
import { anomalyMeta } from '../anomalies'
import { targetLabel } from '../types'
import { Dot } from '../components/ui'

function ActiveStrip() {
  const active = useStore((s) => s.snapshot?.active ?? [])
  const visible = useStore((s) => s.snapshot?.visible ?? [])
  const conn = useStore((s) => s.conn)
  if (conn !== 'connected') return null
  return (
    <div className="active-strip" aria-live="polite">
      <span className="active-strip-label">Happening now</span>
      {active.length === 0 ? (
        <span className="muted">Nothing active</span>
      ) : (
        active.map((a) => (
          <span key={`${a.id}-${a.target}`} className="fired-chip">
            <Dot color={anomalyMeta(a.id).color} size={8} />
            {anomalyMeta(a.id).name}
            {a.target ? <span className="muted"> on {targetLabel(a.target, visible)}</span> : null}
          </span>
        ))
      )}
    </div>
  )
}

function RecentThumb({ path, alt }: { path: string | null; alt: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (path) fileUrl(path).then((u) => { if (alive) setSrc(u) })
    return () => { alive = false }
  }, [path])
  return <div className="recent-thumb">{src ? <img src={src} alt={alt} loading="lazy" /> : null}</div>
}

function RecentCaptures() {
  const sessions = useApp((s) => s.sessions)
  const setView = useApp((s) => s.setView)
  const recent = sessions.slice(0, 4)
  if (recent.length === 0) return null
  return (
    <section className="recent">
      <header className="recent-head">
        <h3>Recent captures</h3>
        <button className="link-btn" onClick={() => setView('library')}>Open Library <ArrowRight size={14} /></button>
      </header>
      <div className="recent-list">
        {recent.map((s) => {
          const n = Object.values(s.counts).reduce((a, b) => a + b, 0)
          return (
            <button key={s.path} className="recent-card" onClick={() => setView('library')}>
              <RecentThumb path={s.thumb} alt={s.id} />
              <span className="recent-meta">
                <span className="recent-time">{new Date(s.createdMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="muted">{s.frames} frames · {n} {n === 1 ? 'anomaly' : 'anomalies'}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function CaptureView() {
  const discovery = useApp((s) => s.discovery)
  const conn = useStore((s) => s.conn)
  const ep = discovery?.endpoint
  const sub = conn === 'connected' && ep ? `${ep.project_name} · ${ep.kind === 'editor' ? 'Unreal Editor' : 'Game build'}` : 'Not connected'
  return (
    <div className="view view-capture">
      <header className="view-head">
        <div>
          <h1>Capture</h1>
          <p className="view-sub">{sub}</p>
        </div>
      </header>
      <div className="capture-grid">
        <div className="capture-main">
          <LiveView />
          <ActiveStrip />
          <RecentCaptures />
        </div>
        <SetupPanel />
      </div>
    </div>
  )
}
