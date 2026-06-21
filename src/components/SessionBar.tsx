import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { client } from '../transport/AnomalyClient'
import { metres } from '../lib/format'

function PollRadiusSlider({ value }: { value: number }) {
  const [local, setLocal] = useState(value)
  const [dragging, setDragging] = useState(false)
  // Re-sync from the server's value when not actively dragging (avoids fighting the 5 Hz echo).
  useEffect(() => { if (!dragging) setLocal(value) }, [value, dragging])
  const MAX_CM = 20000 // 200 m
  return (
    <label className="inline poll" title="Poll radius (cull distance). Low end = OFF.">
      poll <b>{metres(local)}</b>
      <input
        type="range" min={0} max={MAX_CM} step={100} value={local}
        onMouseDown={() => setDragging(true)}
        onMouseUp={() => setDragging(false)}
        onChange={(e) => { const cm = Number(e.target.value); setLocal(cm); client.setPollRadius(cm) }}
      />
    </label>
  )
}

export function SessionBar() {
  const conn = useStore((s) => s.conn)
  const session = useStore((s) => s.snapshot?.session)
  const auto = useStore((s) => s.snapshot?.auto)
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
      <button className="danger" onClick={() => client.revertAll()} title="Revert every active anomaly">Revert all</button>
      <label className="inline">
        <input type="checkbox" checked={!!session?.viewportScoping} onChange={(e) => client.setViewportScoping(e.target.checked)} />
        scoping
      </label>
      <label className="inline">
        <input type="checkbox" checked={!!session?.selectorHud} onChange={(e) => client.setHud('selector', e.target.checked)} />
        selector HUD
      </label>
      <label className="inline">
        <input type="checkbox" checked={!!session?.autoHud} onChange={(e) => client.setHud('auto', e.target.checked)} />
        auto HUD
      </label>
      <span className="sep" />
      <PollRadiusSlider value={session?.pollRadius ?? 0} />
      <span className="grow" />
      <button onClick={() => client.disconnect()}>Disconnect</button>
    </div>
  )
}
