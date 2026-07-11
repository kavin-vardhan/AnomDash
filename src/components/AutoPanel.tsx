import { useStore, useControlValue, useLive, HIDDEN_ANOMALY_IDS } from '../store'
import { client } from '../transport/AnomalyClient'

function PoolCheck({ id, fallback, enabled, onToggle }: { id: string; fallback: boolean; enabled: boolean; onToggle: (id: string, on: boolean) => void }) {
  const on = useControlValue<boolean>(`auto.pool.${id}`, fallback)
  return (
    <label className="inline pool-item">
      <input type="checkbox" checked={on} disabled={!enabled} onChange={(e) => onToggle(id, e.target.checked)} />
      {id}
    </label>
  )
}

export function AutoPanel() {
  const auto = useStore((s) => s.snapshot?.auto)
  const setOptimistic = useStore((s) => s.setOptimistic)
  const mode = useStore((s) => s.captureMode)
  const { live } = useLive()

  if (!auto) return <div className="panel auto"><h3>Capture pool</h3><div className="dim">—</div></div>

  const targeted = mode === 'targeted'
  const poolIds = Object.keys(auto.pool).filter((id) => !HIDDEN_ANOMALY_IDS.has(id))

  const togglePool = (id: string, on: boolean) => {
    if (client.autoConfig({ pool: { [id]: on } })) setOptimistic(`auto.pool.${id}`, on)
  }

  return (
    <div className="panel auto">
      <h3>Capture pool</h3>

      <div className="dim small cap-mode-note">
        {targeted ? 'targeted mode — pool inactive' : 'auto-pool capture draws a random mix from these'}
      </div>

      <div className={`pool${targeted ? ' inactive' : ''}`}>
        {poolIds.length === 0 && <span className="dim small">no pool</span>}
        {poolIds.map((id) => <PoolCheck key={id} id={id} fallback={auto.pool[id]} enabled={live && !targeted} onToggle={togglePool} />)}
      </div>

      <div className="nowfiring">
        <div className="nf-head dim">now firing ({auto.liveFires.length})</div>
        {auto.liveFires.map((f) => (
          <div key={f.id} className="nf-row">
            <span className="aid">{f.id}</span>
            <span className="atarget">{f.target}</span>
            <span className="dim">{f.secondsRemaining.toFixed(1)}s</span>
          </div>
        ))}
        {auto.liveFires.length === 0 && <div className="dim small">none</div>}
      </div>
    </div>
  )
}
