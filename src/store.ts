import { create } from 'zustand'
import type { Snapshot, CatalogEntry, FrameData, ConnState, EventEntry } from './types'

const MAX_EVENTS = 300
const OPT_TTL = 2500
const ACTIVE_TTL = 3000
const STALL_MS = 2000

export const HIDDEN_ANOMALY_IDS = new Set(['lod_corruption', 'lod_popping', 'time_dilation', 'lighting_mismatch'])

function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj)
}

function appendEvent(events: EventEntry[], kind: string, text: string): EventEntry[] {
  const base = events.length >= MAX_EVENTS ? events.slice(-(MAX_EVENTS - 1)) : events.slice()
  base.push({ t: Date.now(), kind, text })
  return base
}

function deriveSnapshotEvents(prev: Snapshot | null, next: Snapshot): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = []
  if (!prev) return out

  const prevActive = new Map(prev.active.map((a) => [a.id, a]))
  const nextActive = new Map(next.active.map((a) => [a.id, a]))
  for (const [id, a] of nextActive) {
    if (!prevActive.has(id)) {
      out.push(
        a.source === 'auto'
          ? { kind: 'auto', text: `auto fired ${id}${a.target ? ` on ${a.target}` : ''}` }
          : { kind: 'inject', text: `injected ${id}${a.target ? ` on ${a.target}` : ''}` },
      )
    }
  }
  for (const [id, a] of prevActive) {
    if (!nextActive.has(id)) {
      out.push(a.source === 'auto' ? { kind: 'auto', text: `${id} auto-reverted` } : { kind: 'inject', text: `reverted ${id}` })
    }
  }
  if (prev.auto.running !== next.auto.running) {
    out.push({ kind: 'auto', text: next.auto.running ? 'auto-injection started' : 'auto-injection stopped' })
  }
  if (prev.capture.running !== next.capture.running) {
    out.push(
      next.capture.running
        ? { kind: 'capture', text: 'capture started' }
        : { kind: 'capture', text: `capture complete (${next.capture.framesWritten} frames saved)` },
    )
  }
  return out
}

interface Optimistic { value: unknown; until: number }
interface PendingInject { id: string; target: string; source: string; at: number }
interface PendingRevert { id: string; at: number }
interface CaptureStopped { runDir: string; frames: number; seed: number; at: number }

interface AppState {
  conn: ConnState
  everConnected: boolean
  wsUrl: string
  token: string
  lastError?: string

  snapshot: Snapshot | null
  catalog: CatalogEntry[]
  frame: FrameData | null
  lastCaptureStopped: CaptureStopped | null
  lastSnapshotAt: number
  stalled: boolean

  selectedActor: string | null
  overlay: { boxes: boolean; labels: boolean; active: boolean }
  events: EventEntry[]

  optimistic: Record<string, Optimistic>
  pendingInjects: PendingInject[]
  pendingReverts: PendingRevert[]

  setConn: (c: ConnState, err?: string) => void
  setCreds: (wsUrl: string, token: string) => void
  setSnapshot: (s: Snapshot) => void
  setCatalog: (c: CatalogEntry[]) => void
  setFrame: (f: FrameData) => void
  setCaptureStopped: (d: CaptureStopped) => void
  selectActor: (name: string | null) => void
  toggleOverlay: (k: 'boxes' | 'labels' | 'active') => void
  pushEvent: (kind: string, text: string) => void
  setOptimistic: (path: string, value: unknown, ttlMs?: number) => void
  addPendingInject: (id: string, target: string, source?: string) => void
  addPendingReverts: (ids: string[]) => void
  tick: () => void
  hardReset: () => void
}

export const useStore = create<AppState>((set, get) => ({
  conn: 'disconnected',
  everConnected: false,
  wsUrl: 'ws://127.0.0.1:8077',
  token: '',
  snapshot: null,
  catalog: [],
  frame: null,
  lastCaptureStopped: null,
  lastSnapshotAt: 0,
  stalled: false,
  selectedActor: null,
  overlay: { boxes: true, labels: true, active: true },
  events: [],
  optimistic: {},
  pendingInjects: [],
  pendingReverts: [],

  setConn: (c, err) =>
    set((st) => {
      let events = st.events
      if (c === 'connected' && st.conn !== 'connected') {
        events = appendEvent(events, 'system', st.everConnected ? 'connection restored' : 'connected to server')
      } else if (c === 'disconnected' && st.everConnected && st.conn !== 'disconnected') {
        events = appendEvent(events, 'system', 'connection lost — reconnecting…')
      }
      return { conn: c, lastError: err, everConnected: st.everConnected || c === 'connected', events }
    }),
  setCreds: (wsUrl, token) => set({ wsUrl, token }),

  setSnapshot: (s) =>
    set((st) => {
      const now = Date.now()
      const optimistic: Record<string, Optimistic> = {}
      for (const [path, e] of Object.entries(st.optimistic)) {
        if (now <= e.until && resolvePath(s, path) !== e.value) optimistic[path] = e
      }
      const activeIds = new Set(s.active.map((a) => a.id))
      const pendingInjects = st.pendingInjects.filter((p) => !activeIds.has(p.id) && now - p.at < ACTIVE_TTL)
      const pendingReverts = st.pendingReverts.filter((r) => activeIds.has(r.id) && now - r.at < ACTIVE_TTL)

      let events = st.events
      for (const d of deriveSnapshotEvents(st.snapshot, s)) events = appendEvent(events, d.kind, d.text)

      return { snapshot: s, optimistic, pendingInjects, pendingReverts, events, lastSnapshotAt: now, stalled: false }
    }),

  setCatalog: (c) => set({ catalog: c.filter((e) => !HIDDEN_ANOMALY_IDS.has(e.id)) }),
  setFrame: (f) => {
    const prev = get().frame
    if (prev?.bitmap) prev.bitmap.close()
    set({ frame: f })
  },
  setCaptureStopped: (d) =>
    set((st) => ({ lastCaptureStopped: d, events: appendEvent(st.events, 'capture', `run complete — ${d.frames} frames saved`) })),
  selectActor: (name) => set({ selectedActor: name }),
  toggleOverlay: (k) => set((st) => ({ overlay: { ...st.overlay, [k]: !st.overlay[k] } })),
  pushEvent: (kind, text) => set((st) => ({ events: appendEvent(st.events, kind, text) })),

  setOptimistic: (path, value, ttlMs = OPT_TTL) =>
    set((st) => ({ optimistic: { ...st.optimistic, [path]: { value, until: Date.now() + ttlMs } } })),
  addPendingInject: (id, target, source = 'manual') =>
    set((st) => ({ pendingInjects: [...st.pendingInjects.filter((p) => p.id !== id), { id, target, source, at: Date.now() }] })),
  addPendingReverts: (ids) =>
    set((st) => {
      const have = new Set(st.pendingReverts.map((r) => r.id))
      const now = Date.now()
      return { pendingReverts: [...st.pendingReverts, ...ids.filter((id) => !have.has(id)).map((id) => ({ id, at: now }))] }
    }),

  tick: () =>
    set((st) => {
      const now = Date.now()
      let optimistic = st.optimistic
      let pruned = false
      const kept: Record<string, Optimistic> = {}
      for (const [k, e] of Object.entries(st.optimistic)) {
        if (now <= e.until) kept[k] = e
        else pruned = true
      }
      if (pruned) optimistic = kept
      const stalled = st.conn === 'connected' && st.lastSnapshotAt > 0 && now - st.lastSnapshotAt > STALL_MS
      if (!pruned && stalled === st.stalled) return {}
      return { optimistic, stalled }
    }),

  hardReset: () => {
    const prev = get().frame
    if (prev?.bitmap) prev.bitmap.close()
    set({
      conn: 'disconnected', everConnected: false, snapshot: null, frame: null, catalog: [],
      selectedActor: null, optimistic: {}, pendingInjects: [], pendingReverts: [],
      lastSnapshotAt: 0, stalled: false,
    })
  },
}))

export function useLive() {
  const conn = useStore((s) => s.conn)
  const stalled = useStore((s) => s.stalled)
  return { connected: conn === 'connected', stalled, live: conn === 'connected' && !stalled }
}

export function useControlValue<T>(path: string, fallback: T): T {
  const opt = useStore((s) => s.optimistic[path])
  return opt !== undefined ? (opt.value as T) : fallback
}
