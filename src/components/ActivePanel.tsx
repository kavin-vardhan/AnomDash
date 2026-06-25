import { useStore, useLive } from '../store'
import { client } from '../transport/AnomalyClient'

export function ActivePanel() {
  const active = useStore((s) => s.snapshot?.active ?? [])
  const liveFires = useStore((s) => s.snapshot?.auto.liveFires ?? [])
  const pendingInjects = useStore((s) => s.pendingInjects)
  const pendingReverts = useStore((s) => s.pendingReverts)
  const addPendingReverts = useStore((s) => s.addPendingReverts)
  const { live } = useLive()

  const revertingIds = new Set(pendingReverts.map((r) => r.id))
  const activeIds = new Set(active.map((a) => a.id))
  const shown = active.filter((a) => !revertingIds.has(a.id))
  const pendingShown = pendingInjects.filter((p) => !activeIds.has(p.id))

  const countdown = (id: string): number | undefined => liveFires.find((f) => f.id === id)?.secondsRemaining

  const revertOne = (id: string) => { if (client.revert(id)) addPendingReverts([id]) }
  const revertAll = () => { if (client.revertAll()) addPendingReverts(active.map((a) => a.id)) }

  const total = shown.length + pendingShown.length

  return (
    <div className="panel active">
      <h3>Active ({total})</h3>
      <div className="list">
        {shown.map((a) => {
          const cd = countdown(a.id)
          return (
            <div key={a.id} className="arow">
              <div className="arow-main">
                <span className="aid">{a.id}</span>
                <span className="atarget" title={a.args.join(' ')}>{a.target || '(global)'}</span>
              </div>
              <div className="arow-meta">
                <span className={`src ${a.source}`}>{a.source}</span>
                <span className="dim">{a.tActive.toFixed(1)}s{cd !== undefined ? ` · ${cd.toFixed(1)}s left` : ''}</span>
                <button disabled={!live} onClick={() => revertOne(a.id)}>revert</button>
              </div>
            </div>
          )
        })}
        {pendingShown.map((p) => (
          <div key={`p:${p.id}`} className="arow pending">
            <div className="arow-main">
              <span className="aid">{p.id}</span>
              <span className="atarget">{p.target || '(global)'}</span>
            </div>
            <div className="arow-meta"><span className="dim">injecting…</span></div>
          </div>
        ))}
        {total === 0 && <div className="empty">no active anomalies</div>}
      </div>
      <button className="danger" disabled={!live || !active.length} onClick={revertAll}>Revert all</button>
    </div>
  )
}
