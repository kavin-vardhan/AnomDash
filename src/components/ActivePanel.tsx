import { useStore, useLive } from '../store'
import { client } from '../transport/AnomalyClient'
import { targetLabel } from '../types'

export function ActivePanel() {
  const active = useStore((s) => s.snapshot?.active ?? [])
  const visible = useStore((s) => s.snapshot?.visible ?? [])
  const liveFires = useStore((s) => s.snapshot?.auto.liveFires ?? [])
  const pendingReverts = useStore((s) => s.pendingReverts)
  const addPendingReverts = useStore((s) => s.addPendingReverts)
  const { live, connected } = useLive()

  const revertingIds = new Set(pendingReverts.map((r) => r.id))
  const shown = active.filter((a) => !revertingIds.has(a.id))

  const countdown = (id: string): number | undefined => liveFires.find((f) => f.id === id)?.secondsRemaining

  const revertOne = (id: string) => { if (client.revert(id)) addPendingReverts([id]) }
  const revertAll = () => { if (client.revertAll()) addPendingReverts(active.map((a) => a.id)) }

  const total = shown.length

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
                <span className="atarget" title={[a.target, a.args.join(' ')].filter(Boolean).join(' · ')}>
                  {targetLabel(a.target, visible) || '(global)'}
                </span>
              </div>
              <div className="arow-meta">
                <span className={`src ${a.source}`}>{a.source}</span>
                <span className="dim">{a.tActive.toFixed(1)}s{cd !== undefined ? ` · ${cd.toFixed(1)}s left` : ''}</span>
                <button disabled={!live} onClick={() => revertOne(a.id)}>revert</button>
              </div>
            </div>
          )
        })}
        {total === 0 && <div className="empty">no active anomalies</div>}
      </div>
      <button className="danger" disabled={!connected || !active.length} onClick={revertAll}>Revert all</button>
    </div>
  )
}
