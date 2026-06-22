// Types for the LOCKED INPUTS from the in-game control server (server is feature-complete; do not change it).

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
  comp: string // "SM" | "SK" (VFX removed from the renderable set)
  dist: number
  rect: number[] // [x0,y0,x1,y1] normalized, top-left origin
  rectValid: boolean
}

export interface ActiveAnomaly {
  id: string
  target: string
  args: string[]
  source: string // "manual" | "auto"
  tActive: number
  // NOTE: the server's active[] does NOT currently emit secondsRemaining (only auto.liveFires does).
  // Optional here; ActivePanel (Slice B) can cross-reference auto.liveFires by id.
  secondsRemaining?: number
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
  pool: Record<string, boolean> // the firing pool (object-scoped ids), authoritative
  liveFires: LiveFire[]
}

export interface SessionInfo {
  viewportScoping: boolean
  selectorHud: boolean
  autoHud: boolean
  fps: number
  activeCount: number
  pollRadius: number // cm; 0 = OFF
  minScreenCoverage: number // percent of viewport area; 0 = OFF
}

export interface CaptureInfo {
  running: boolean
  framesWritten: number
  runDir: string
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

export type ConnState = 'disconnected' | 'connecting' | 'authenticating' | 'connected'

export interface EventEntry {
  t: number
  kind: string
  text: string
}
