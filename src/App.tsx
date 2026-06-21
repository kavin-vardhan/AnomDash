import { useStore } from './store'
import { ConnectScreen } from './components/ConnectScreen'
import { SessionBar } from './components/SessionBar'
import { PreviewCanvas } from './components/PreviewCanvas'
import { TargetsPanel } from './components/TargetsPanel'
import { RawDump } from './components/RawDump'

export default function App() {
  const everConnected = useStore((s) => s.everConnected)

  // Show the connect screen until the first successful connect; after that keep the dashboard mounted
  // (the SessionBar shows a reconnecting banner) so the canvas/state survive a brief drop.
  if (!everConnected) return <ConnectScreen />

  return (
    <div className="app">
      <SessionBar />
      <div className="main">
        <div className="col left">
          <TargetsPanel />
        </div>
        <div className="col center">
          <PreviewCanvas />
        </div>
        <div className="col right">
          {/* Slice B: InjectPanel + ActivePanel · Slice C: AutoPanel · Slice D: CapturePanel + EventLog */}
          <div className="panel placeholder">
            <h3>Controls</h3>
            <p className="dim">Inject · Active · Auto · Capture — Slices B–D.</p>
          </div>
        </div>
      </div>
      <RawDump />
    </div>
  )
}
