import { useState } from 'react'
import { useStore } from '../store'
import { fmtTime } from '../lib/format'

const KINDS = ['all', 'inject', 'auto', 'capture', 'system'] as const
type Kind = (typeof KINDS)[number]

export function EventLog() {
  const events = useStore((s) => s.events)
  const [filter, setFilter] = useState<Kind>('all')

  const shown = filter === 'all' ? events : events.filter((e) => e.kind === filter)

  return (
    <div className="eventlog">
      <div className="el-head">
        <span className="el-title">Activity</span>
        <div className="el-filters">
          {KINDS.map((k) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{k}</button>
          ))}
        </div>
      </div>
      <div className="el-list">
        {[...shown].reverse().map((e) => (
          <div key={e.seq} className={`el-row ${e.kind}`}>
            <span className="el-t">{fmtTime(e.t)}</span>
            <span className={`el-k ${e.kind}`}>{e.kind}</span>
            <span className="el-x">{e.text}</span>
          </div>
        ))}
        {shown.length === 0 && <div className="dim small el-empty">no activity yet</div>}
      </div>
    </div>
  )
}
