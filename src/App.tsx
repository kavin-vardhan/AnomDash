import { useEffect } from 'react'
import { useApp } from './appStore'
import { useStore } from './store'
import { Rail } from './components/Rail'
import { CaptureView } from './views/CaptureView'
import { LibraryView } from './views/LibraryView'
import { SettingsView } from './views/SettingsView'
import { initApp } from './appInit'

export default function App() {
  const view = useApp((s) => s.view)
  const recording = useStore((s) => !!s.snapshot?.capture.running)

  useEffect(() => {
    void initApp()
  }, [])

  return (
    <div className={`shell${recording ? ' is-recording' : ''}`}>
      <Rail />
      <main className="stage">
        {view === 'capture' && <CaptureView />}
        {view === 'library' && <LibraryView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
