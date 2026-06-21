import { useState } from 'react'
import { useStore } from '../store'

export function TargetsPanel() {
  const visible = useStore((s) => s.snapshot?.visible ?? [])
  const selected = useStore((s) => s.selectedActor)
  const selectActor = useStore((s) => s.selectActor)
  const [filter, setFilter] = useState('')

  const f = filter.trim().toLowerCase()
  const rows = f
    ? visible.filter((v) => v.name.toLowerCase().includes(f) || v.class.toLowerCase().includes(f))
    : visible

  return (
    <div className="panel targets">
      <h3>Objects on screen ({visible.length})</h3>
      <input className="filter" placeholder="filter by name / type…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="list">
        {rows.map((v) => (
          <div
            key={v.name}
            className={`row ${v.name === selected ? 'sel' : ''}`}
            onClick={() => selectActor(v.name === selected ? null : v.name)}
            title={v.class}
          >
            <span className="nm">{v.name}</span>
            <span className="meta">{v.comp} · {Math.round(v.dist)}u</span>
          </div>
        ))}
        {rows.length === 0 && <div className="empty">{visible.length ? 'no matches' : 'nothing visible'}</div>}
      </div>
    </div>
  )
}
