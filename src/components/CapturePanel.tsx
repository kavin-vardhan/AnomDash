import { useState } from 'react'
import { useStore, useControlValue, useLive } from '../store'
import { client } from '../transport/AnomalyClient'
import { basename } from '../lib/format'

export function CapturePanel() {
  const cap = useStore((s) => s.snapshot?.capture)
  const lastStopped = useStore((s) => s.lastCaptureStopped)
  const setOptimistic = useStore((s) => s.setOptimistic)

  const [dir, setDir] = useState('')
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [seed, setSeed] = useState('')

  const running = useControlValue<boolean>('capture.running', cap?.running ?? false)
  const { live } = useLive()

  const start = () => {
    const opts: Record<string, unknown> = { format }
    if (dir.trim()) opts.dir = dir.trim()
    if (seed.trim() && !Number.isNaN(Number(seed))) opts.seed = Number(seed)
    if (client.captureStart(opts)) setOptimistic('capture.running', true)
  }
  const stop = () => {
    if (client.captureStop()) setOptimistic('capture.running', false)
  }

  return (
    <div className="panel capture">
      <h3>Capture dataset</h3>

      {!running && (
        <>
          <label className="field">
            output folder (optional)
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
          </div>
        </>
      )}

      <div className="cap-controls">
        {!running
          ? <button disabled={!live} onClick={start}>Start capture</button>
          : <button className="danger" disabled={!live} onClick={stop}>Stop capture</button>}
      </div>

      {running && cap && (
        <div className="cap-status live">
          <span className="rec">● recording</span> — <b>{cap.framesWritten}</b> frames saved
          <div className="dim" title={cap.runDir}>{basename(cap.runDir)}</div>
        </div>
      )}
      {!running && lastStopped && (
        <div className="cap-status done">
          run complete: <b>{lastStopped.frames}</b> frames saved → <span title={lastStopped.runDir}>{basename(lastStopped.runDir)}</span>
        </div>
      )}
    </div>
  )
}
