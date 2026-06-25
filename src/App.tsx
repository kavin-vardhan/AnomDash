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

  useEffect(() => {
    const id = setInterval(() => useStore.getState().tick(), 500)
    return () => clearInterval(id)
  }, [])

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
