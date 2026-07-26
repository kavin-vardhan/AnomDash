import { useEffect, useMemo, useRef } from 'react'
import { useStore, useControlValue, useLive } from '../store'
import { client } from '../transport/AnomalyClient'
import { metres, coveragePct } from '../lib/format'
import { throttle } from '../lib/throttle'
import { consoleStatus } from '../lib/status'

const sendPollRadius = (cm: number) => client.setPollRadius(cm)
const sendCoverage = (pct: number) => client.setMinScreenCoverage(pct)

function OptToggle({ path, label, value, onSet }: { path: string; label: string; value: boolean; onSet: (v: boolean) => boolean }) {
  const shown = useControlValue<boolean>(path, value)
  const { live } = useLive()
  return (
    <label className="inline">
      <input
        type="checkbox"
        checked={shown}
        disabled={!live}
        onChange={(e) => { if (onSet(e.target.checked)) useStore.getState().setOptimistic(path, e.target.checked) }}
      />
      {label}
    </label>
  )
}

interface ThrottledSliderProps {
  path: string
  prefix: string
  className?: string
  title: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  send: (v: number) => boolean
}

function ThrottledSlider({ path, prefix, className, title, min, max, step, value, format, send }: ThrottledSliderProps) {
  const shown = useControlValue<number>(path, value)
  const { live } = useLive()
  const throttled = useMemo(() => throttle((v: number) => { send(v) }, 100), [send])
  useEffect(() => () => throttled.cancel(), [throttled])
  const last = useRef(value)

  const drag = (v: number) => {
    last.current = v
    useStore.getState().setOptimistic(path, v)
    throttled(v)
  }
  const commit = () => {
    throttled.cancel()
    const v = last.current
    if (send(v)) useStore.getState().setOptimistic(path, v)
  }

  return (
    <label className={className ? `inline ${className}` : 'inline'} title={title}>
      {prefix} <b>{format(shown)}</b>
      <input
        type="range" min={min} max={max} step={step} value={shown}
        disabled={!live}
        onChange={(e) => drag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
    </label>
  )
}

export function SessionBar() {
  const conn = useStore((s) => s.conn)
  const stalled = useStore((s) => s.stalled)
  const capturing = useStore((s) => !!s.snapshot?.capture.running)
  const session = useStore((s) => s.snapshot?.session)
  const auto = useStore((s) => s.snapshot?.auto)
  const { connected } = useLive()
  const status = consoleStatus({ conn, stalled, capturing })

  return (
    <div className="session-bar">
      <span className={`status-chip is-${status.key}`} title={conn === 'auth_failed' ? 'token rejected by server' : conn}>
        <span className={`status-dot${status.pulses ? ' pulsing' : ''}`} />
        <span className="status-word">{status.word}</span>
      </span>
      <span className="sep" />
      <span>FPS <b>{session ? Math.round(session.fps) : '—'}</b></span>
      <span>seed <b>{auto ? auto.seed : '—'}</b></span>
      <span>active <b>{session ? session.activeCount : '—'}</b></span>
      <span className="sep" />
      <button className="danger" disabled={!connected} onClick={() => client.revertAll()} title="Revert every active anomaly">Revert all</button>
      <OptToggle path="session.viewportScoping" label="scoping" value={!!session?.viewportScoping} onSet={(v) => client.setViewportScoping(v)} />
      <OptToggle path="session.selectorHud" label="selector HUD" value={!!session?.selectorHud} onSet={(v) => client.setHud('selector', v)} />
      <OptToggle path="session.autoHud" label="auto HUD" value={!!session?.autoHud} onSet={(v) => client.setHud('auto', v)} />
      <span className="sep" />
      <ThrottledSlider
        path="session.pollRadius" prefix="poll" className="poll"
        title="Poll radius (cull distance). Low end = OFF."
        min={0} max={20000} step={100}
        value={session?.pollRadius ?? 0} format={metres} send={sendPollRadius}
      />
      <ThrottledSlider
        path="session.minScreenCoverage" prefix="coverage"
        title="Min on-screen coverage to be an anomaly target (percent of viewport). Zero = Off."
        min={0} max={100} step={1}
        value={session?.minScreenCoverage ?? 0} format={coveragePct} send={sendCoverage}
      />
      <span className="grow" />
      <button onClick={() => client.disconnect()}>Disconnect</button>
    </div>
  )
}
