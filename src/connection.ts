import { useStore } from './store'
import { useApp } from './appStore'
import { client } from './transport/AnomalyClient'
import { backend, inTauri } from './backend'

const POLL_MS = 2000

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let busy = false

function current() {
  const s = useStore.getState()
  return { conn: s.conn, url: s.wsUrl, token: s.token }
}

async function step() {
  if (busy) return
  busy = true
  try {
    const settings = useApp.getState().settings
    const { conn, token } = current()
    if (settings && settings.manualToken.trim()) {
      const url = settings.manualUrl.trim() || 'ws://127.0.0.1:8077'
      if (conn === 'auth_failed' || (conn === 'disconnected' && token !== settings.manualToken.trim())) {
        useStore.getState().setCreds(url, settings.manualToken.trim())
        client.connect(url, settings.manualToken.trim())
      }
      return
    }
    if (conn === 'connected' || conn === 'connecting' || conn === 'authenticating') {
      if (conn === 'connected') return
    }
    const d = await backend.discover()
    useApp.getState().setDiscovery(d)
    const after = current()
    if (d.status !== 'found' || !d.endpoint) return
    const ep = d.endpoint
    const needsConnect =
      after.conn === 'auth_failed' ||
      (after.conn === 'disconnected' && (after.token !== ep.token || !useStore.getState().everConnected)) ||
      (after.conn === 'disconnected' && after.url !== ep.url)
    if (needsConnect) {
      useStore.getState().setCreds(ep.url, ep.token)
      client.connect(ep.url, ep.token)
    }
  } catch (err) {
    console.warn('discovery failed', err)
  } finally {
    busy = false
  }
}

function loop() {
  timer = setTimeout(async () => {
    await step()
    loop()
  }, POLL_MS)
}

export async function startConnection() {
  if (started) return
  started = true
  if (!inTauri && import.meta.env.DEV) {
    if (location.search.includes('offline')) {
      useApp.getState().setDiscovery({ status: 'no_server', endpoint: null, editor_running: location.search.includes('editor'), detail: '' })
      return
    }
    const { startMockGame } = await import('./mock/mockGame')
    useApp.getState().setDiscovery(await backend.discover())
    startMockGame()
    return
  }
  await step()
  loop()
}

export function reconnectNow() {
  if (timer) clearTimeout(timer)
  const s = useStore.getState()
  if (s.conn !== 'connected') client.disconnect()
  step().finally(loop)
}
