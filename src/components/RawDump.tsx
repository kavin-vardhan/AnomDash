import { useState } from 'react'
import { useStore } from '../store'

// A0 bring-up aid: a collapsible corner panel proving the framing-agnostic transport (snapshot + frame both
// arrive and decode). Handy debug; superseded by the real EventLog in Slice D.
export function RawDump() {
  const conn = useStore((s) => s.conn)
  const snap = useStore((s) => s.snapshot)
  const frame = useStore((s) => s.frame)
  const catalog = useStore((s) => s.catalog)
  const events = useStore((s) => s.events)
  const [open, setOpen] = useState(true)

  return (
    <div className="rawdump">
      <div className="rawdump-head" onClick={() => setOpen((o) => !o)}>A0 raw {open ? '▾' : '▸'}</div>
      {open && (
        <div className="rawdump-body">
          <div>conn: <b>{conn}</b></div>
          <div>catalog: {catalog.length} entries</div>
          <div>frame: {frame ? `${frame.w}×${frame.h} #${frame.frameId} epoch ${frame.epoch}` : '—'}</div>
          <div>
            snapshot: {snap ? `t=${snap.t.toFixed(1)} epoch=${snap.epoch} visible=${snap.visible.length} active=${snap.active.length}` : '—'}
          </div>
          <div>
            session: {snap ? `fps=${Math.round(snap.session.fps)} poll=${snap.session.pollRadius} scoping=${snap.session.viewportScoping}` : '—'}
          </div>
          <div>capture: {snap ? `running=${snap.capture.running} frames=${snap.capture.framesWritten}` : '—'}</div>
          <div className="rawevents">
            {events.slice(-8).map((e, i) => <div key={i}>{e.kind}: {e.text}</div>)}
          </div>
        </div>
      )}
    </div>
  )
}
