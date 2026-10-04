import { useApp } from './appStore'
import { useStore } from './store'
import { backend } from './backend'
import { startConnection } from './connection'
import { startRecorder } from './recorder'

let initialized = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null

export async function refreshSessions() {
  try {
    const list = await backend.listSessions()
    useApp.getState().setSessions(list)
  } catch (err) {
    console.warn('could not list captures', err)
    useApp.getState().setSessions([])
  }
}

function scheduleRefresh(ms = 300) {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshSessions()
  }, ms)
}

export async function initApp() {
  if (initialized) return
  initialized = true
  setInterval(() => useStore.getState().tick(), 500)
  try {
    useApp.getState().setSettings(await backend.getSettings())
  } catch (err) {
    console.warn('settings unavailable', err)
  }
  startRecorder()
  await startConnection()
  void refreshSessions()
  void backend.onSessionsChanged(() => scheduleRefresh(150))
  void backend.onGenerateProgress((p) => {
    const app = useApp.getState()
    if (p.session === '*') {
      app.setGenerating(false)
      app.clearSelection()
      scheduleRefresh(100)
      return
    }
    app.applyProgress(p)
    if (p.step === 'all' && p.state !== 'queued') scheduleRefresh(100)
    const jobs = useApp.getState().jobs
    const busy = Object.values(jobs).some((j) => j.state === 'queued' || j.state === 'running')
    if (!busy && app.generating) {
      app.setGenerating(false)
      app.clearSelection()
    }
  })
  useStore.subscribe((s, prev) => {
    const was = prev.snapshot?.capture
    const now = s.snapshot?.capture
    if (was?.running && now && !now.running) {
      const last = s.lastCaptureStopped
      const fresh = last && Date.now() - last.at < 4000
      if (!fresh) {
        s.setCaptureStopped({
          runDir: now.runDir || was.runDir,
          sessionId: now.sessionId || was.sessionId,
          frames: Math.max(now.framesWritten, was.framesWritten),
          maxFrames: was.maxFrames,
          seed: was.seed,
          at: Date.now(),
        })
      }
    }
    if (s.lastCaptureStopped && s.lastCaptureStopped !== prev.lastCaptureStopped) {
      useApp.getState().setJustSaved(s.lastCaptureStopped.sessionId)
      scheduleRefresh(800)
    }
  })
  window.addEventListener('focus', () => scheduleRefresh(50))
}
