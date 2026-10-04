import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw, Film, Layers, ScanSearch, Trash2, MoreHorizontal, Loader2, CheckCircle2, AlertCircle, Images } from 'lucide-react'
import { useApp } from '../appStore'
import { backend, fileUrl, type SessionInfo } from '../backend'
import { anomalyMeta, sortAnomalyIds } from '../anomalies'
import { Timeline } from '../components/Timeline'
import { Button, Dot } from '../components/ui'
import { refreshSessions } from '../appInit'

function when(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`
}

function secs(frames: number, fps: number): string {
  const s = frames / (fps > 0 ? fps : 30)
  if (s < 60) return `${s.toFixed(1)} s`
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min`
}

function Thumb({ path, id }: { path: string | null; id: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (path) fileUrl(path).then((u) => { if (alive) setSrc(u) })
    else setSrc(null)
    return () => { alive = false }
  }, [path])
  return (
    <div className="thumb">
      {src ? <img src={src} alt={`First labelled frame of ${id}`} loading="lazy" /> : <Images size={22} strokeWidth={1.5} />}
    </div>
  )
}

function OutputBadge({ on, label, icon, onOpen, pending }: { on: boolean; label: string; icon: React.ReactNode; onOpen?: () => void; pending?: boolean }) {
  return (
    <button className={`out-badge${on ? ' on' : ''}${pending ? ' pending' : ''}`} disabled={!on || !onOpen} onClick={onOpen} title={on ? `Open ${label.toLowerCase()}` : pending ? `${label}: ready to generate` : `${label}: not generated`}>
      {icon}
      <span>{label}</span>
    </button>
  )
}

function RowMenu({ s }: { s: SessionInfo }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => { setOpen(false); setConfirm(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])
  return (
    <div className="row-menu" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label="More actions" aria-expanded={open} onClick={() => setOpen((v) => !v)}><MoreHorizontal size={18} /></button>
      {open && (
        <div className="menu">
          <button onClick={() => { backend.openPath(s.path); setOpen(false) }}><FolderOpen size={15} /> Open folder</button>
          {!confirm ? (
            <button className="danger" onClick={() => setConfirm(true)}><Trash2 size={15} /> Move to Recycle Bin…</button>
          ) : (
            <button className="danger strong" onClick={async () => { await backend.deleteSession(s.path); setOpen(false); refreshSessions() }}>
              <Trash2 size={15} /> Yes, move this capture to the Recycle Bin
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function JobLine({ path }: { path: string }) {
  const job = useApp((s) => s.jobs[path])
  if (!job) return null
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0
  if (job.state === 'done') return <div className="job done"><CheckCircle2 size={14} /> Generated</div>
  if (job.state === 'error') return <div className="job error"><AlertCircle size={14} /> {job.message}</div>
  if (job.state === 'cancelled') return <div className="job">Cancelled</div>
  if (job.state === 'queued') return <div className="job">Queued…</div>
  return (
    <div className="job running">
      <Loader2 size={14} className="spin" />
      <span>{job.message}{job.total > 0 ? ` · ${pct}%` : ''}</span>
      <span className="job-bar"><span style={{ width: `${pct}%` }} /></span>
    </div>
  )
}

function SessionRow({ s }: { s: SessionInfo }) {
  const selected = useApp((st) => !!st.selected[s.path])
  const toggle = useApp((st) => st.toggleSelected)
  const segs = s.events.flatMap((e) => e.runs.map(([a, b]) => ({ type: e.type, start: a, end: b })))
  const kinds = sortAnomalyIds(Object.keys(s.counts))
  const finishing = !s.complete || s.masks === 'waiting'
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0)

  return (
    <div className={`srow${selected ? ' is-selected' : ''}${finishing ? ' is-finishing' : ''}`} onClick={() => !finishing && toggle(s.path)}>
      <label className="srow-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} disabled={finishing} onChange={() => toggle(s.path)} aria-label={`Select ${s.id}`} />
      </label>
      <Thumb path={s.thumb} id={s.id} />
      <div className="srow-main">
        <div className="srow-title">
          <span className="srow-when">{when(s.createdMs)}</span>
          <span className="srow-id">{s.id}</span>
        </div>
        <div className="srow-stats">
          <span>{secs(s.frames, s.fps)}</span>
          <span>{s.frames} frames</span>
          {s.width > 0 && <span>{s.width}×{s.height}</span>}
          <span>{total} {total === 1 ? 'anomaly' : 'anomalies'}</span>
        </div>
        <Timeline total={s.frames} segments={segs} size="sm" label={`${total} anomalies across ${s.frames} frames`} />
        <div className="srow-kinds">
          {kinds.map((k) => (
            <span key={k} className="kind"><Dot color={anomalyMeta(k).color} size={7} />{anomalyMeta(k).name}<b>{s.counts[k]}</b></span>
          ))}
        </div>
        {finishing ? <div className="job"><Loader2 size={14} className="spin" /> Finishing up…</div> : <JobLine path={s.path} />}
        {s.error ? <div className="job error"><AlertCircle size={14} /> {s.error}</div> : null}
      </div>
      <div className="srow-outs" onClick={(e) => e.stopPropagation()}>
        <OutputBadge on={!!s.video} label="Video" icon={<Film size={14} />} onOpen={s.video ? () => backend.openPath(s.video!) : undefined} />
        <OutputBadge
          on={s.masks === 'released'}
          pending={s.masks === 'pending'}
          label={s.masks === 'none' ? 'No masks' : 'Masks'}
          icon={<Layers size={14} />}
          onOpen={s.masks === 'released' ? () => backend.openPath(`${s.path}\\target_mask`) : undefined}
        />
        <OutputBadge on={s.previews > 0} label="Previews" icon={<ScanSearch size={14} />} onOpen={s.previews > 0 ? () => backend.openPath(`${s.path}\\annotated`) : undefined} />
        <RowMenu s={s} />
      </div>
    </div>
  )
}

function GenerateBar() {
  const selected = useApp((s) => s.selected)
  const sessions = useApp((s) => s.sessions)
  const outputs = useApp((s) => s.outputs)
  const setOutput = useApp((s) => s.setOutput)
  const generating = useApp((s) => s.generating)
  const setGenerating = useApp((s) => s.setGenerating)
  const clearSelection = useApp((s) => s.clearSelection)
  const paths = sessions.filter((s) => selected[s.path]).map((s) => s.path)
  const any = outputs.video || outputs.masks || outputs.previews
  if (paths.length === 0 && !generating) return null

  const go = async () => {
    setGenerating(true)
    try {
      await backend.generate({ sessions: paths, ...outputs })
    } catch (err) {
      setGenerating(false)
      console.warn(err)
    }
  }

  return (
    <div className="gen-bar" role="region" aria-label="Generate outputs">
      <div className="gen-count">
        <b>{paths.length}</b> {paths.length === 1 ? 'capture' : 'captures'} selected
        {!generating && <button className="link-btn" onClick={clearSelection}>Clear</button>}
      </div>
      <div className="gen-opts">
        <label className={`gen-opt${outputs.video ? ' on' : ''}`}>
          <input type="checkbox" checked={outputs.video} disabled={generating} onChange={(e) => setOutput('video', e.target.checked)} />
          <Film size={15} /> Video
        </label>
        <label className={`gen-opt${outputs.masks ? ' on' : ''}`}>
          <input type="checkbox" checked={outputs.masks} disabled={generating} onChange={(e) => setOutput('masks', e.target.checked)} />
          <Layers size={15} /> Target masks
        </label>
        <label className={`gen-opt${outputs.previews ? ' on' : ''}`}>
          <input type="checkbox" checked={outputs.previews} disabled={generating} onChange={(e) => setOutput('previews', e.target.checked)} />
          <ScanSearch size={15} /> Labelled previews
        </label>
      </div>
      {generating ? (
        <Button variant="secondary" onClick={() => backend.cancelGenerate()}>Cancel</Button>
      ) : (
        <Button variant="primary" disabled={!any || paths.length === 0} onClick={go}>Generate</Button>
      )}
    </div>
  )
}

export function LibraryView() {
  const sessions = useApp((s) => s.sessions)
  const loaded = useApp((s) => s.sessionsLoaded)
  const settings = useApp((s) => s.settings)
  const setSelected = useApp((s) => s.setSelected)
  const selected = useApp((s) => s.selected)
  const setView = useApp((s) => s.setView)
  const ready = useMemo(() => sessions.filter((s) => s.complete && s.masks !== 'waiting'), [sessions])
  const allOn = ready.length > 0 && ready.every((s) => selected[s.path])

  return (
    <div className="view view-library">
      <header className="view-head">
        <div>
          <h1>Library</h1>
          <p className="view-sub">{loaded ? `${sessions.length} ${sessions.length === 1 ? 'capture' : 'captures'} in ${settings?.capturesRoot ?? 'your captures folder'}` : 'Loading…'}</p>
        </div>
        <div className="view-actions">
          <Button variant="ghost" icon={<RefreshCw size={15} />} onClick={() => refreshSessions()}>Refresh</Button>
          <Button variant="secondary" icon={<FolderOpen size={15} />} disabled={!settings?.capturesRoot} onClick={() => settings && backend.openPath(settings.capturesRoot)}>Open folder</Button>
        </div>
      </header>

      {loaded && sessions.length === 0 ? (
        <div className="empty">
          <Images size={34} strokeWidth={1.4} />
          <h2>No captures yet</h2>
          <p>Captures you record show up here. Pick the ones you need, then generate videos, target masks or labelled previews.</p>
          <Button variant="primary" onClick={() => setView('capture')}>Start a capture</Button>
        </div>
      ) : (
        <>
          <div className="list-head">
            <label className="srow-check">
              <input type="checkbox" checked={allOn} onChange={(e) => setSelected(ready.map((s) => s.path), e.target.checked)} aria-label="Select all captures" />
            </label>
            <span>Select all</span>
            <span className="grow" />
            <span className="legend"><span className="legend-dot on" />generated</span>
            <span className="legend"><span className="legend-dot pending" />ready to generate</span>
          </div>
          <div className="srows">
            {sessions.map((s) => <SessionRow key={s.path} s={s} />)}
          </div>
        </>
      )}
      <GenerateBar />
    </div>
  )
}
