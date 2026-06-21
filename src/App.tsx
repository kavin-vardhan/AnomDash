import { useEffect } from 'react'
import { useStore } from './store'
import { ConnectScreen } from './components/ConnectScreen'
import { ConnectionBanner } from './components/ConnectionBanner'
import { SessionBar } from './components/SessionBar'
import { PreviewCanvas } from './components/PreviewCanvas'
import { TargetsPanel } from './components/TargetsPanel'
import { InjectPanel } from './components/InjectPanel'
import { ActivePanel } from './components/ActivePanel'
import { AutoPanel } from './components/AutoPanel'
import { CapturePanel } from './components/CapturePanel'
import { EventLog } from './components/EventLog'

export default function App() {
  const everConnected = useStore((s) => s.everConnected)

  // Timer-drive optimistic expiry + stall detection (independent of the snapshot stream).
  useEffect(() => {
    const id = setInterval(() => useStore.getState().tick(), 500)
    return () => clearInterval(id)
  }, [])

  // Show the connect screen until the first successful connect; after that keep the dashboard mounted
  // (the ConnectionBanner shows reconnect/stall state) so the canvas/state survive a brief drop.
  if (!everConnected) return <ConnectScreen />

  return (
    <div className="app">
      <SessionBar />
      <ConnectionBanner />
      <div className="main">
        <div className="col left">
          <TargetsPanel />
        </div>
        <div className="col center">
          <PreviewCanvas />
        </div>
        <div className="col right">
          <InjectPanel />
          <ActivePanel />
          <AutoPanel />
          <CapturePanel />
        </div>
      </div>
      <EventLog />
    </div>
  )
}
