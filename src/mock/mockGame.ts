import { useStore } from '../store'
import { client } from '../transport/AnomalyClient'
import type { Snapshot, VisibleActor, CatalogEntry } from '../types'
import { addMockSession } from './backendMock'

const W = 1280
const H = 720

const OBJECTS: Array<{ name: string; asset: string; rect: number[]; color: string }> = [
  { name: 'StaticMeshActor_12', asset: 'SM_Crate_Large', rect: [0.08, 0.52, 0.27, 0.86], color: '#9C6B3F' },
  { name: 'StaticMeshActor_40', asset: 'SM_Pillar', rect: [0.36, 0.18, 0.44, 0.86], color: '#8C939E' },
  { name: 'BP_MovingPlatform_C_3', asset: 'SM_Platform', rect: [0.52, 0.6, 0.78, 0.7], color: '#4E7DBA' },
  { name: 'StaticMeshActor_77', asset: 'SM_Rock_02', rect: [0.8, 0.62, 0.95, 0.88], color: '#6E6A62' },
  { name: 'Bot_C_0', asset: 'SKM_Bot', rect: [0.6, 0.34, 0.69, 0.6], color: '#E8E4DA' },
]

const CATALOG: CatalogEntry[] = [
  'blinking', 'missing_object', 'missing_texture', 'corrupted_texture', 'lod_popping',
  'camera_clipping', 'stuck_low_mip', 'uv_corruption', 'normal_corruption',
].map((id) => ({
  id,
  description: id,
  usage: '',
  scope: id === 'camera_clipping' ? 'global' : 'object',
  targetable: id !== 'camera_clipping',
  args: [],
}))

let pool: Record<string, boolean> = {
  blinking: true, missing_texture: true, corrupted_texture: true, lod_popping: true,
  missing_object: false, camera_clipping: false, stuck_low_mip: true, uv_corruption: true, normal_corruption: true,
}
let pollRadius = 1800
let coverage = 6
let capture = { running: false, framesWritten: 0, maxFrames: 0, framesRemaining: 0, runDir: '', sessionId: '', seed: 0 }
let liveFire: { id: string; target: string; until: number } | null = null
let epoch = 1
let frameId = 0
let t0 = performance.now()
let startedAt = 0

function sessionStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `session_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function visible(): VisibleActor[] {
  return OBJECTS.map((o, i) => ({
    name: o.name,
    class: o.name.split('_')[0],
    comp: 'StaticMeshComponent',
    asset: o.asset,
    compClass: 'StaticMeshComponent',
    dist: 600 + i * 230,
    rect: o.rect,
    rectValid: true,
  }))
}

function snapshot(): Snapshot {
  const now = performance.now()
  const active = liveFire && liveFire.until > now
    ? [{ id: liveFire.id, target: liveFire.target, args: [], source: 'auto', tActive: (now - (liveFire.until - 2500)) / 1000 }]
    : []
  return {
    v: 1,
    type: 'snapshot',
    t: (now - t0) / 1000,
    epoch,
    view: { origin: [0, 0, 0], rot: [0, 0, 0], fovDeg: 90, aspect: W / H, viewportPx: [W, H], valid: true },
    visible: visible(),
    active,
    auto: {
      enabled: true, running: capture.running, seed: 4242, intervalMin: 1, intervalMax: 3, holdMin: 1, holdMax: 2,
      maxConcurrent: 2, persist: false, pool: { ...pool },
      liveFires: active.map((a) => ({ id: a.id, target: a.target, secondsRemaining: Math.max(0, ((liveFire?.until ?? 0) - now) / 1000) })),
    },
    session: { viewportScoping: false, selectorHud: false, autoHud: false, fps: 58 + Math.random() * 4, activeCount: active.length, pollRadius, minScreenCoverage: coverage },
    capture: { ...capture },
  }
}

async function frame(): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(W, H)
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, H * 0.55)
  sky.addColorStop(0, '#9DC4E8')
  sky.addColorStop(1, '#E3EEF6')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  const ground = g.createLinearGradient(0, H * 0.55, 0, H)
  ground.addColorStop(0, '#7FA36B')
  ground.addColorStop(1, '#4E6E42')
  g.fillStyle = ground
  g.fillRect(0, H * 0.55, W, H * 0.45)
  const now = performance.now()
  const firing = liveFire && liveFire.until > now ? liveFire : null
  for (const o of OBJECTS) {
    const [x0, y0, x1, y1] = o.rect
    let color = o.color
    let hidden = false
    if (firing && firing.target === o.name) {
      if (firing.id === 'corrupted_texture') color = '#FF00FF'
      if (firing.id === 'blinking') hidden = Math.floor(now / 120) % 2 === 0
      if (firing.id === 'missing_texture') color = '#BBBBBB'
    }
    if (hidden) continue
    g.fillStyle = color
    g.fillRect(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H)
    g.fillStyle = 'rgba(0,0,0,0.18)'
    g.fillRect(x0 * W, y1 * H - 8, (x1 - x0) * W, 8)
  }
  return c.transferToImageBitmap()
}

function startCapture(msg: Record<string, unknown>) {
  const max = Number(msg.maxFrames ?? 0)
  const d = new Date()
  capture = { running: true, framesWritten: 0, maxFrames: max, framesRemaining: max, runDir: `C:\\Users\\you\\Documents\\AnomalyCaptures\\${sessionStamp(d)}`, sessionId: sessionStamp(d), seed: 4242 }
  startedAt = performance.now()
}

function stopCapture() {
  if (!capture.running) return
  const done = { ...capture }
  capture = { ...capture, running: false }
  useStore.getState().setCaptureStopped({
    runDir: done.runDir, sessionId: done.sessionId, frames: done.framesWritten, maxFrames: done.maxFrames, seed: 4242, at: Date.now(),
    targetFps: 30, stampedFps: 30, speedRatio: 1, paced: true,
  })
  addMockSession(done.sessionId, done.framesWritten)
}

function handle(obj: unknown): boolean {
  const msg = obj as Record<string, unknown>
  switch (msg?.type) {
    case 'capture_start': startCapture(msg); break
    case 'capture_stop': stopCapture(); break
    case 'auto_config': {
      const p = msg.pool as Record<string, boolean> | undefined
      if (p) pool = { ...pool, ...p }
      break
    }
    case 'set_poll_radius': pollRadius = Number(msg.cm); break
    case 'set_min_screen_coverage': coverage = Number(msg.pct); break
    case 'revert_all': liveFire = null; break
    default: break
  }
  return true
}

export function startMockGame() {
  const st = useStore.getState()
  ;(client as unknown as { send: (o: unknown) => boolean }).send = handle
  st.setCreds('ws://127.0.0.1:8077', 'mock')
  st.setConn('connected')
  st.setCatalog(CATALOG)
  t0 = performance.now()
  setInterval(() => {
    const now = performance.now()
    if (capture.running) {
      const elapsed = (now - startedAt) / 1000
      const n = Math.max(0, Math.floor((elapsed - 1.2) * 30))
      capture.framesWritten = n
      capture.framesRemaining = capture.maxFrames > 0 ? Math.max(0, capture.maxFrames - n) : 0
      if (!liveFire || liveFire.until < now) {
        const ids = Object.keys(pool).filter((k) => pool[k] && k !== 'camera_clipping')
        const id = ids[Math.floor(Math.random() * ids.length)] ?? 'blinking'
        const target = OBJECTS[Math.floor(Math.random() * OBJECTS.length)].name
        liveFire = { id, target, until: now + 2500 }
      }
      if (capture.maxFrames > 0 && n >= capture.maxFrames) {
        capture.framesWritten = capture.maxFrames
        stopCapture()
      }
    }
    useStore.getState().setSnapshot(snapshot())
  }, 200)
  setInterval(async () => {
    if (capture.running) return
    const bitmap = await frame()
    frameId += 1
    useStore.getState().setFrame({ bitmap, frameId, epoch, w: W, h: H })
  }, 160)
}
