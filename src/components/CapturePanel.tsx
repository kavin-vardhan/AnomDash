import { useEffect, useMemo, useState } from 'react'
import { useStore, useControlValue, useLive } from '../store'
import { client } from '../transport/AnomalyClient'
import { basename } from '../lib/format'
import { capturesRoot } from '../config'

export function CapturePanel() {
  const cap = useStore((s) => s.snapshot?.capture)
  const lastStopped = useStore((s) => s.lastCaptureStopped)
  const setOptimistic = useStore((s) => s.setOptimistic)

  const mode = useStore((s) => s.captureMode)
  const setMode = useStore((s) => s.setCaptureMode)
  const catalog = useStore((s) => s.catalog)
  const visible = useStore((s) => s.snapshot?.visible ?? [])
  const selected = useStore((s) => s.selectedActor)
  const selectActor = useStore((s) => s.selectActor)

  const [dir, setDir] = useState(capturesRoot())
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [seed, setSeed] = useState('')
  const [frames, setFrames] = useState('120')
  const [anomalyId, setAnomalyId] = useState('')

  const running = useControlValue<boolean>('capture.running', cap?.running ?? false)
  const { live, connected } = useLive()

  const objectAnomalies = useMemo(() => catalog.filter((e) => e.scope === 'object'), [catalog])

  useEffect(() => {
    if (!anomalyId && objectAnomalies.length) setAnomalyId(objectAnomalies[0].id)
  }, [objectAnomalies, anomalyId])

  const framesNum = Number(frames)
  const framesValid = frames.trim() !== '' && Number.isFinite(framesNum) && framesNum > 0

  const targeted = mode === 'targeted'
  const targetReady = !!selected && !!anomalyId
  const canStart = live && (!targeted || targetReady)

  const start = () => {
    const opts: Record<string, unknown> = { format }
    if (dir.trim()) opts.dir = dir.trim()
    if (seed.trim() && !Number.isNaN(Number(seed))) opts.seed = Number(seed)
    if (framesValid) opts.maxFrames = Math.floor(framesNum)
    if (targeted && selected && anomalyId) {
      opts.anomaly = anomalyId
      opts.target = selected
    }
    if (client.captureStart(opts)) setOptimistic('capture.running', true)
  }
  const stop = () => {
    if (client.captureStop()) setOptimistic('capture.running', false)
  }

  const maxFrames = cap?.maxFrames ?? 0
  const pct = maxFrames > 0 ? Math.min(100, Math.round(((cap?.framesWritten ?? 0) / maxFrames) * 100)) : 0
  const reachedCap = !!lastStopped && lastStopped.maxFrames > 0 && lastStopped.frames >= lastStopped.maxFrames
  const doneName = (lastStopped?.sessionId || basename(lastStopped?.runDir ?? '')) as string

  return (
    <div className="panel capture">
      <h3>Capture dataset</h3>

      {!running && (
        <>
          <div className="mode-toggle">
            <button className={targeted ? '' : 'on'} onClick={() => setMode('auto')}>Auto-pool</button>
            <button className={targeted ? 'on' : ''} onClick={() => setMode('targeted')}>Targeted</button>
          </div>

          {targeted ? (
            <>
              <label className="field">
                anomaly
                <select value={anomalyId} onChange={(e) => setAnomalyId(e.target.value)}>
                  {objectAnomalies.length === 0 && <option value="">loading catalog…</option>}
                  {objectAnomalies.map((e) => <option key={e.id} value={e.id}>{e.id}</option>)}
                </select>
              </label>
              <label className="field">
                target (on-screen)
                <select value={selected ?? ''} onChange={(e) => selectActor(e.target.value || null)}>
                  <option value="">— pick / click the preview —</option>
                  {visible.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </select>
              </label>
            </>
          ) : (
            <div className="dim small cap-mode-note">fires a random mix from the pool below.</div>
          )}

          <label className="field">
            captures folder{capturesRoot() ? ' — the encoder watches here (set in Setup)' : ' (optional)'}
            <input value={dir} placeholder="default: Saved/AnomalyCaptures" onChange={(e) => setDir(e.target.value)} />
          </label>
          <div className="cap-row">
            <label className="inline">
              format
              <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')}>
                <option value="png">PNG (lossless)</option>
                <option value="jpeg">JPEG (smaller)</option>
              </select>
            </label>
            <label className="inline">
              seed <input className="seed-in" value={seed} placeholder="auto" onChange={(e) => setSeed(e.target.value)} />
            </label>
            <label className="inline" title="Session length: capture auto-stops after this many frames, then finalizes. Blank / 0 = until Stop.">
              frames <input className="seed-in" type="number" min={1} value={frames} placeholder="∞" onChange={(e) => setFrames(e.target.value)} />
            </label>
          </div>
        </>
      )}

      <div className="cap-controls">
        {!running
          ? <button disabled={!canStart} onClick={start}>Start capture</button>
          : <button className="danger" disabled={!connected} onClick={stop}>Stop capture</button>}
      </div>
      {!running && targeted && !targetReady && <div className="warn small">pick an object + anomaly</div>}

      {running && cap && (
        <div className="cap-status live">
          <span className="rec">● recording</span> — <b>{cap.framesWritten}</b>{maxFrames > 0 ? <> / {maxFrames} frames <span className="dim">({pct}%)</span></> : <> frames saved</>}
          {maxFrames > 0 && (
            <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', marginTop: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: '#e0483d', transition: 'width 0.15s linear' }} />
            </div>
          )}
          <div className="dim" title={cap.runDir}>{cap.sessionId || basename(cap.runDir)}</div>
        </div>
      )}
      {!running && lastStopped && (
        <div className="cap-status done">
          run complete: <b>{lastStopped.frames}</b> frames saved{reachedCap ? ' (reached cap)' : ''} → <span title={lastStopped.runDir}>{doneName}</span>
        </div>
      )}
      {!running && lastStopped
        && typeof lastStopped.targetFps === 'number'
        && typeof lastStopped.stampedFps === 'number'
        && Math.abs(lastStopped.stampedFps - lastStopped.targetFps) > 0.0005 && (
        <div className="warn small">
          couldn't hold {lastStopped.targetFps} fps — video stamped at {lastStopped.stampedFps} fps (true speed)
        </div>
      )}
    </div>
  )
}
