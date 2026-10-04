export interface GameEndpoint {
  url: string
  token: string
  pid: number
  process_name: string
  project_name: string
  log_path: string
  kind: string
}

export interface Discovery {
  status: 'found' | 'no_server' | 'no_token' | string
  endpoint: GameEndpoint | null
  editor_running: boolean
  detail: string
}

export interface AppSettings {
  capturesRoot: string
  port: number
  manualUrl: string
  manualToken: string
  version: string
}

export interface EventRun {
  type: string
  runs: Array<[number, number]>
}

export interface SessionInfo {
  id: string
  path: string
  createdMs: number
  complete: boolean
  finalized: boolean
  frames: number
  fps: number
  width: number
  height: number
  events: EventRun[]
  counts: Record<string, number>
  thumb: string | null
  masks: 'pending' | 'released' | 'none' | 'waiting'
  maskFrames: number
  video: string | null
  previews: number
  error: string | null
}

export interface GenerateRequest {
  sessions: string[]
  video: boolean
  masks: boolean
  previews: boolean
}

export interface GenerateProgress {
  session: string
  step: 'video' | 'masks' | 'previews' | 'all'
  state: 'queued' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled'
  done: number
  total: number
  message: string
}

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type Unlisten = () => void

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, (e) => cb(e.payload))
}

export async function fileUrl(path: string): Promise<string> {
  if (!inTauri) return mockFileUrl(path)
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  return convertFileSrc(path)
}

let mock: typeof import('./mock/backendMock') | null = null
async function m(): Promise<typeof import('./mock/backendMock')> {
  if (import.meta.env.DEV) {
    if (!mock) mock = await import('./mock/backendMock')
    return mock
  }
  throw new Error('This page must run inside the Anomaly Dashboard app.')
}

function mockFileUrl(path: string): string {
  return path
}

export const backend = {
  async discover(): Promise<Discovery> {
    if (inTauri) return tauriInvoke<Discovery>('discover_game')
    return (await m()).discover()
  },
  async getSettings(): Promise<AppSettings> {
    if (inTauri) return tauriInvoke<AppSettings>('get_settings')
    return (await m()).getSettings()
  },
  async setCapturesRoot(path: string): Promise<AppSettings> {
    if (inTauri) return tauriInvoke<AppSettings>('set_captures_root', { path })
    return (await m()).setCapturesRoot(path)
  },
  async setManual(url: string, token: string): Promise<AppSettings> {
    if (inTauri) return tauriInvoke<AppSettings>('set_manual_connection', { url, token })
    return (await m()).setManual(url, token)
  },
  async pickFolder(): Promise<string | null> {
    if (inTauri) return tauriInvoke<string | null>('pick_folder')
    return (await m()).pickFolder()
  },
  async listSessions(): Promise<SessionInfo[]> {
    if (inTauri) return tauriInvoke<SessionInfo[]>('list_sessions')
    return (await m()).listSessions()
  },
  async generate(req: GenerateRequest): Promise<void> {
    if (inTauri) return tauriInvoke<void>('generate', { req })
    return (await m()).generate(req)
  },
  async cancelGenerate(): Promise<void> {
    if (inTauri) return tauriInvoke<void>('cancel_generate')
    return (await m()).cancelGenerate()
  },
  async openPath(path: string): Promise<void> {
    if (inTauri) return tauriInvoke<void>('open_path', { path })
    return (await m()).openPath(path)
  },
  async deleteSession(path: string): Promise<void> {
    if (inTauri) return tauriInvoke<void>('delete_session', { path })
    return (await m()).deleteSession(path)
  },
  async onGenerateProgress(cb: (p: GenerateProgress) => void): Promise<Unlisten> {
    if (inTauri) return tauriListen<GenerateProgress>('generate-progress', cb)
    return (await m()).onGenerateProgress(cb)
  },
  async onSessionsChanged(cb: () => void): Promise<Unlisten> {
    if (inTauri) return tauriListen<unknown>('sessions-changed', () => cb())
    return (await m()).onSessionsChanged(cb)
  },
}
