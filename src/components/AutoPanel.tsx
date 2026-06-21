import { useEffect, useState } from 'react'
import { useStore, useControlValue, useLive } from '../store'
import { client } from '../transport/AnomalyClient'

// Free-typed numeric field: local while editing, re-syncs from the snapshot when not focused, commits on
// blur / Enter (so e.g. the seed field doesn't re-seed on every keystroke).
function NumField({ label, value, step, min, disabled, onCommit }: { label: string; value: number; step?: number; min?: number; disabled?: boolean; onCommit: (n: number) => void }) {
  const [local, setLocal] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!editing) setLocal(String(value)) }, [value, editing])
  const commit = () => {
    setEditing(false)
    const n = Number(local)
    if (local.trim() !== '' && !Number.isNaN(n)) onCommit(n)
  }
  return (
    <label className="numfield">
      <span>{label}</span>
      <input
        type="number" step={step ?? 1} min={min} value={local} disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
    </label>
  )
}

// One pool checkbox (optimistic — flips instantly only if the command went out). NOT disabled during a
// capture run: the pool is the user's injection SELECTION for capture (only Auto's free-run loop is suppressed).
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
  const captureRunning = useStore((s) => s.snapshot?.capture?.running ?? false)
  const setOptimistic = useStore((s) => s.setOptimistic)
  const { live } = useLive()
  const [stepSecs, setStepSecs] = useState('1')

  const running = useControlValue<boolean>('auto.running', auto?.running ?? false)
  const persist = useControlValue<boolean>('auto.persist', auto?.persist ?? false)

  if (!auto) return <div className="panel auto"><h3>Auto-injection</h3><div className="dim">—</div></div>

  const poolIds = Object.keys(auto.pool)
  // Auto's free-run loop competes with capture's own driver -> block running it while capture owns injection.
  const runDisabled = !live || captureRunning

  const togglePool = (id: string, on: boolean) => {
    if (client.autoConfig({ pool: { [id]: on } })) setOptimistic(`auto.pool.${id}`, on)
  }
  const toggleRun = () => {
    const next = !running
    if (client.autoRun(next)) setOptimistic('auto.running', next)
  }
  const togglePersist = (on: boolean) => {
    if (client.autoConfig({ persist: on })) setOptimistic('auto.persist', on)
  }

  return (
    <div className="panel auto">
      <h3>Auto-injection</h3>

      <div className="auto-run-row">
        <button className={running ? 'danger' : ''} disabled={runDisabled} onClick={toggleRun}>{running ? 'Stop' : 'Run'}</button>
        <span className={running ? 'live' : 'dim'}>{captureRunning ? 'capture owns injection' : running ? 'running' : auto.enabled ? 'enabled, idle' : 'idle'}</span>
      </div>

      <div className="pool">
        {poolIds.length === 0 && <span className="dim small">no pool</span>}
        {poolIds.map((id) => <PoolCheck key={id} id={id} fallback={auto.pool[id]} enabled={live} onToggle={togglePool} />)}
      </div>

      <div className="cadence">
        <div className="cad-pair">
          <NumField label="interval" value={auto.intervalMin} step={0.5} min={0} disabled={!live} onCommit={(n) => client.autoConfig({ intervalMin: n })} />
          <NumField label="–" value={auto.intervalMax} step={0.5} min={0} disabled={!live} onCommit={(n) => client.autoConfig({ intervalMax: n })} />
        </div>
        <div className="cad-pair">
          <NumField label="hold" value={auto.holdMin} step={0.5} min={0} disabled={!live} onCommit={(n) => client.autoConfig({ holdMin: n })} />
          <NumField label="–" value={auto.holdMax} step={0.5} min={0} disabled={!live} onCommit={(n) => client.autoConfig({ holdMax: n })} />
        </div>
        <NumField label="maxConc" value={auto.maxConcurrent} step={1} min={1} disabled={!live} onCommit={(n) => client.autoConfig({ maxConcurrent: n })} />
        <NumField label="seed" value={auto.seed} step={1} disabled={!live} onCommit={(n) => client.autoConfig({ seed: n })} />
        <label className="inline persist"><input type="checkbox" checked={persist} disabled={!live} onChange={(e) => togglePersist(e.target.checked)} />persist</label>
      </div>

      <div className="dev-row">
        <button disabled={runDisabled} onClick={() => client.autoFireOnce()}>fire once</button>
        <button disabled={runDisabled} onClick={() => { const n = Number(stepSecs); if (!Number.isNaN(n)) client.autoStep(n) }}>step</button>
        <input className="step-in" type="number" step={0.5} value={stepSecs} onChange={(e) => setStepSecs(e.target.value)} />
        <span className="dim">s (dev)</span>
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
