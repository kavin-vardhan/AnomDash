export interface ViewInfo {
  origin: number[]
  rot: number[]
  fovDeg: number
  aspect: number
  viewportPx: number[]
  valid: boolean
}

export interface VisibleActor {
  name: string
  class: string
  comp: string
  dist: number
  rect: number[]
  rectValid: boolean
}

export interface ActiveAnomaly {
  id: string
  target: string
  args: string[]
  source: string
  tActive: number
}

export interface LiveFire {
  id: string
  target: string
  secondsRemaining: number
}

export interface AutoState {
  enabled: boolean
  running: boolean
  seed: number
  intervalMin: number
  intervalMax: number
  holdMin: number
  holdMax: number
  maxConcurrent: number
  persist: boolean
  pool: Record<string, boolean>
  liveFires: LiveFire[]
}

export interface SessionInfo {
  viewportScoping: boolean
  selectorHud: boolean
  autoHud: boolean
  fps: number
  activeCount: number
  pollRadius: number
  minScreenCoverage: number
}

export interface CaptureInfo {
  running: boolean
  framesWritten: number
  maxFrames: number
  framesRemaining: number
  runDir: string
  sessionId: string
  seed: number
}

export interface Snapshot {
  v: number
  type: 'snapshot'
  t: number
  epoch: number
  view: ViewInfo
  visible: VisibleActor[]
  active: ActiveAnomaly[]
  auto: AutoState
  session: SessionInfo
  capture: CaptureInfo
}

export interface ArgSpec {
  name: string
  type: 'float' | 'int' | 'enum' | 'bool' | 'string'
  required: boolean
  default: string
  min?: number
  max?: number
  options?: string[]
}

export interface CatalogEntry {
  id: string
  description: string
  usage: string
  scope: 'object' | 'component' | 'global'
  args: ArgSpec[]
}

export interface FrameData {
  bitmap: ImageBitmap
  frameId: number
  epoch: number
  w: number
  h: number
}

export type ConnState = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'auth_failed'

export interface EventEntry {
  seq: number
  t: number
  kind: string
  text: string
}
