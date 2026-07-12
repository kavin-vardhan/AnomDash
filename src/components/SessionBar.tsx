import { useEffect, useMemo, useRef } from 'react'
import { useStore, useControlValue, useLive } from '../store'
import { client } from '../transport/AnomalyClient'
import { metres, coveragePct } from '../lib/format'
import { throttle } from '../lib/throttle'

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

function PollRadiusSlider({ value }: { value: number }) {
  const shown = useControlValue<number>('session.pollRadius', value)
  const { live } = useLive()
  const MAX_CM = 20000
  return (
    <label className="inline poll" title="Poll radius (cull distance). Low end = OFF.">
      poll <b>{metres(shown)}</b>
      <input
        type="range" min={0} max={MAX_CM} step={100} value={shown}
        disabled={!live}
        onChange={(e) => { const cm = Number(e.target.value); if (client.setPollRadius(cm)) useStore.getState().setOptimistic('session.pollRadius', cm) }}
      />
    </label>
  )
}

function CoverageSlider({ value }: { value: number }) {
  const shown = useControlValue<number>('session.minScreenCoverage', value)
  const { live } = useLive()
  const send = useMemo(() => throttle((pct: number) => client.setMinScreenCoverage(pct), 100), [])
  useEffect(() => () => send.cancel(), [send])
  const lastPct = useRef(value)

  const drag = (pct: number) => {
    lastPct.current = pct
    useStore.getState().setOptimistic('session.minScreenCoverage', pct)
    send(pct)
  }
  const commit = () => {
    send.cancel()
    const pct = lastPct.current
    if (client.setMinScreenCoverage(pct)) useStore.getState().setOptimistic('session.minScreenCoverage', pct)
  }

  return (
    <label className="inline" title="Min on-screen coverage to be an anomaly target (percent of viewport). Zero = Off.">
      coverage <b>{coveragePct(shown)}</b>
      <input
        type="range" min={0} max={100} step={1} value={shown}
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
  const session = useStore((s) => s.snapshot?.session)
  const auto = useStore((s) => s.snapshot?.auto)
  const { live } = useLive()
  const reconnecting = conn !== 'connected'

  return (
    <div className="session-bar">
      <span className={`dot ${conn === 'connected' ? 'ok' : 'bad'}`} />
      <span className="conn">{reconnecting ? `reconnecting (${conn})` : 'connected'}</span>
      <span className="sep" />
      <span>FPS <b>{session ? Math.round(session.fps) : '—'}</b></span>
      <span>seed <b>{auto ? auto.seed : '—'}</b></span>
      <span>active <b>{session ? session.activeCount : '—'}</b></span>
      <span className="sep" />
      <button className="danger" disabled={!live} onClick={() => client.revertAll()} title="Revert every active anomaly">Revert all</button>
      <OptToggle path="session.viewportScoping" label="scoping" value={!!session?.viewportScoping} onSet={(v) => client.setViewportScoping(v)} />
      <OptToggle path="session.selectorHud" label="selector HUD" value={!!session?.selectorHud} onSet={(v) => client.setHud('selector', v)} />
      <OptToggle path="session.autoHud" label="auto HUD" value={!!session?.autoHud} onSet={(v) => client.setHud('auto', v)} />
      <span className="sep" />
      <PollRadiusSlider value={session?.pollRadius ?? 0} />
      <CoverageSlider value={session?.minScreenCoverage ?? 0} />
      <span className="grow" />
      <button onClick={() => client.disconnect()}>Disconnect</button>
    </div>
  )
}
