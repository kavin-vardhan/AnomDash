import type { AppSettings, Discovery, GenerateProgress, GenerateRequest, SessionInfo } from '../backend'

let settings: AppSettings = {
  capturesRoot: 'C:\\Users\\you\\Documents\\AnomalyCaptures',
  port: 8077,
  manualUrl: '',
  manualToken: '',
  version: '0.2.0-dev',
}

const progressCbs = new Set<(p: GenerateProgress) => void>()
const changedCbs = new Set<() => void>()
let cancelled = false

function thumb(seed: number): string {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, 100)
  sky.addColorStop(0, '#9DC4E8')
  sky.addColorStop(1, '#E3EEF6')
  g.fillStyle = sky
  g.fillRect(0, 0, 320, 180)
  g.fillStyle = '#5E7F52'
  g.fillRect(0, 100, 320, 80)
  const colors = ['#9C6B3F', '#8C939E', '#4E7DBA', '#FF00FF', '#6E6A62']
  for (let i = 0; i < 4; i++) {
    g.fillStyle = colors[(seed + i) % colors.length]
    const x = 20 + ((seed * 37 + i * 71) % 240)
    const h = 30 + ((seed * 13 + i * 29) % 60)
    g.fillRect(x, 140 - h, 34 + (i % 2) * 20, h)
  }
  return c.toDataURL('image/jpeg', 0.8)
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `session_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function makeSession(i: number, ageMin: number, frames: number, kinds: string[], extra: Partial<SessionInfo> = {}): SessionInfo {
  const d = new Date(Date.now() - ageMin * 60000)
  const id = stamp(d)
  const events = kinds.map((type, k) => {
    const start = Math.floor(((k + 1) * frames) / (kinds.length + 1)) - 6
    return { type, runs: [[start, start + 8]] as Array<[number, number]> }
  })
  const counts: Record<string, number> = {}
  for (const k of kinds) counts[k] = (counts[k] ?? 0) + 1
  return {
    id,
    path: `${settings.capturesRoot}\\${id}`,
    createdMs: d.getTime(),
    complete: true,
    finalized: true,
    frames,
    fps: 30,
    width: 1920,
    height: 1080,
    events,
    counts,
    thumb: thumb(i),
    masks: 'pending',
    maskFrames: Math.floor(frames * 0.4),
    video: null,
    previews: 0,
    error: null,
    ...extra,
  }
}

let sessions: SessionInfo[] = [
  makeSession(1, 4, 120, ['blinking', 'corrupted_texture', 'lod_popping', 'missing_texture']),
  makeSession(2, 38, 300, ['missing_texture', 'blinking', 'stuck_low_mip', 'uv_corruption', 'blinking', 'normal_corruption', 'corrupted_texture'], {
    video: 'C:\\Users\\you\\Documents\\AnomalyCaptures\\x\\Video_Clip\\x.mp4',
  }),
  makeSession(3, 60 * 26, 900, ['lod_popping', 'blinking', 'missing_object', 'corrupted_texture', 'missing_texture', 'stuck_low_mip', 'lod_popping', 'blinking', 'uv_corruption', 'normal_corruption'], {
    masks: 'released', video: 'C:\\x.mp4', previews: 412,
  }),
  makeSession(4, 60 * 50, 120, ['corrupted_texture', 'blinking', 'missing_texture'], { masks: 'none', maskFrames: 0 }),
]

export async function discover(): Promise<Discovery> {
  return {
    status: 'found',
    endpoint: { url: 'ws://127.0.0.1:8077', token: 'mock', pid: 1234, process_name: 'UnrealEditor.exe', project_name: 'StackOBot', log_path: 'D:\\Projects\\StackOBot\\Saved\\Logs\\StackOBot.log', kind: 'editor' },
    editor_running: true,
    detail: '',
  }
}

export async function getSettings(): Promise<AppSettings> {
  return settings
}

export async function setCapturesRoot(path: string): Promise<AppSettings> {
  settings = { ...settings, capturesRoot: path }
  return settings
}

export async function setManual(url: string, token: string): Promise<AppSettings> {
  settings = { ...settings, manualUrl: url, manualToken: token }
  return settings
}

export async function pickFolder(): Promise<string | null> {
  return 'D:\\Datasets\\AnomalyCaptures'
}

export async function listSessions(): Promise<SessionInfo[]> {
  return sessions.map((s) => ({ ...s }))
}

export function addMockSession(id: string, frames: number) {
  const s = makeSession(sessions.length + 7, 0, Math.max(frames, 30), ['blinking', 'missing_texture', 'corrupted_texture'])
  sessions = [{ ...s, id, path: `${settings.capturesRoot}\\${id}`, finalized: false, masks: 'waiting' }, ...sessions]
  changedCbs.forEach((cb) => cb())
  setTimeout(() => {
    sessions = sessions.map((x) => (x.id === id ? { ...x, finalized: true, masks: 'pending' } : x))
    changedCbs.forEach((cb) => cb())
  }, 2500)
}

function emit(p: GenerateProgress) {
  progressCbs.forEach((cb) => cb(p))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function generate(req: GenerateRequest): Promise<void> {
  cancelled = false
  void (async () => {
    for (const path of req.sessions) emit({ session: path, step: 'all', state: 'queued', done: 0, total: 0, message: 'Waiting' })
    for (const path of req.sessions) {
      const s = sessions.find((x) => x.path === path)
      if (!s) continue
      if (req.masks) {
        emit({ session: path, step: 'masks', state: 'running', done: 0, total: 1, message: 'Releasing target masks' })
        await sleep(400)
        sessions = sessions.map((x) => (x.path === path && x.masks === 'pending' ? { ...x, masks: 'released' } : x))
      }
      if (req.video) {
        for (let i = 0; i <= s.frames; i += Math.max(1, Math.floor(s.frames / 20))) {
          if (cancelled) break
          emit({ session: path, step: 'video', state: 'running', done: i, total: s.frames, message: 'Encoding video' })
          await sleep(90)
        }
        sessions = sessions.map((x) => (x.path === path ? { ...x, video: `${path}\\Video_Clip\\${x.id}.mp4` } : x))
      }
      if (req.previews && !cancelled) {
        for (let i = 0; i <= s.frames; i += Math.max(1, Math.floor(s.frames / 12))) {
          emit({ session: path, step: 'previews', state: 'running', done: i, total: s.frames, message: 'Drawing labelled previews' })
          await sleep(80)
        }
        sessions = sessions.map((x) => (x.path === path ? { ...x, previews: Math.floor(s.frames * 0.45) } : x))
      }
      emit({ session: path, step: 'all', state: cancelled ? 'cancelled' : 'done', done: 1, total: 1, message: cancelled ? 'Cancelled' : 'Done' })
      changedCbs.forEach((cb) => cb())
      if (cancelled) break
    }
  })()
}

export async function cancelGenerate(): Promise<void> {
  cancelled = true
}

export async function openPath(path: string): Promise<void> {
  console.info('open', path)
}

export async function deleteSession(path: string): Promise<void> {
  sessions = sessions.filter((s) => s.path !== path)
  changedCbs.forEach((cb) => cb())
}

export async function onGenerateProgress(cb: (p: GenerateProgress) => void) {
  progressCbs.add(cb)
  return () => { progressCbs.delete(cb) }
}

export async function onSessionsChanged(cb: () => void) {
  changedCbs.add(cb)
  return () => { changedCbs.delete(cb) }
}
