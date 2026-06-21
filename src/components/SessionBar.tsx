import { useStore, useControlValue } from '../store'
import { client } from '../transport/AnomalyClient'
import { metres } from '../lib/format'

// Optimistic toggle: flips instantly (store), sends the command; the snapshot reconciles.
function OptToggle({ path, label, value, onSet }: { path: string; label: string; value: boolean; onSet: (v: boolean) => void }) {
  const shown = useControlValue<boolean>(path, value)
  return (
    <label className="inline">
      <input
        type="checkbox"
        checked={shown}
        onChange={(e) => { useStore.getState().setOptimistic(path, e.target.checked); onSet(e.target.checked) }}
      />
      {label}
    </label>
  )
}

function PollRadiusSlider({ value }: { value: number }) {
  const shown = useControlValue<number>('session.pollRadius', value)
  const MAX_CM = 20000 // 200 m
  return (
    <label className="inline poll" title="Poll radius (cull distance). Low end = OFF.">
      poll <b>{metres(shown)}</b>
      <input
        type="range" min={0} max={MAX_CM} step={100} value={shown}
        onChange={(e) => { const cm = Number(e.target.value); useStore.getState().setOptimistic('session.pollRadius', cm); client.setPollRadius(cm) }}
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
      <OptToggle path="session.viewportScoping" label="scoping" value={!!session?.viewportScoping} onSet={(v) => client.setViewportScoping(v)} />
      <OptToggle path="session.selectorHud" label="selector HUD" value={!!session?.selectorHud} onSet={(v) => client.setHud('selector', v)} />
      <OptToggle path="session.autoHud" label="auto HUD" value={!!session?.autoHud} onSet={(v) => client.setHud('auto', v)} />
      <span className="sep" />
      <PollRadiusSlider value={session?.pollRadius ?? 0} />
      <span className="grow" />
      <button onClick={() => client.disconnect()}>Disconnect</button>
    </div>
  )
}
