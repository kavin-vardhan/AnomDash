import { useStore, useLive } from '../store'
import { client } from '../transport/AnomalyClient'

// Shown when the dashboard can't trust its state: not connected (reconnecting) or the snapshot stream has
// stalled (engine state unknown). Controls are disabled in this state, so a click can't be silently lost.
export function ConnectionBanner() {
  const { live, connected } = useLive()
  const conn = useStore((s) => s.conn)
  if (live) return null

  const message = !connected
    ? `Not connected (${conn}) — controls disabled.`
    : 'Stream stalled — engine state unknown. Displayed state may be out of date; controls disabled.'

  return (
    <div className={`conn-banner ${connected ? 'stalled' : 'down'}`}>
      <span>⚠ {message}</span>
      <button onClick={() => client.reconnect()}>Reconnect now</button>
    </div>
  )
}
