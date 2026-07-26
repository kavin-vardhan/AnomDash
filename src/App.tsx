import { useEffect } from 'react'
import { useStore } from './store'
import { client } from './transport/AnomalyClient'
import { controlToken, serverUrl } from './config'
import { ConnectScreen } from './components/ConnectScreen'
import { ConnectionBanner } from './components/ConnectionBanner'
import { SessionBar } from './components/SessionBar'
import { PreviewCanvas } from './components/PreviewCanvas'
import { TargetsPanel } from './components/TargetsPanel'
import { ActivePanel } from './components/ActivePanel'
import { AutoPanel } from './components/AutoPanel'
import { CapturePanel } from './components/CapturePanel'
import { EventLog } from './components/EventLog'
import { consoleStatus } from './lib/status'

export default function App() {
  const everConnected = useStore((s) => s.everConnected)
  const conn = useStore((s) => s.conn)
  const stalled = useStore((s) => s.stalled)
  const capturing = useStore((s) => !!s.snapshot?.capture.running)
  const status = consoleStatus({ conn, stalled, capturing })

  useEffect(() => {
    const id = setInterval(() => useStore.getState().tick(), 500)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const token = controlToken()
    if (!token) return
    const s = useStore.getState()
    if (s.conn !== 'disconnected') return
    const url = s.wsUrl || serverUrl()
    s.setCreds(url, token)
    client.connect(url, token)
  }, [])

  if (!everConnected) return <ConnectScreen />

  return (
    <div className={`app is-${status.key}`}>
      <div className="spine" />
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
          <ActivePanel />
          <CapturePanel />
          <AutoPanel />
        </div>
      </div>
      <EventLog />
    </div>
  )
}
