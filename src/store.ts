import { create } from 'zustand'
import type { Snapshot, CatalogEntry, FrameData, ConnState, EventEntry } from './types'

const MAX_EVENTS = 300
const OPT_TTL = 2500 // ms an optimistic scalar persists before the snapshot wins on mismatch
const ACTIVE_TTL = 3000 // ms a pending inject/revert persists before the snapshot wins

// Resolve a dotted path (e.g. "session.pollRadius") against the snapshot.
function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj)
}

interface Optimistic { value: unknown; until: number }
interface PendingInject { id: string; target: string; source: string; at: number }
interface PendingRevert { id: string; at: number }

interface AppState {
  // connection
  conn: ConnState
  everConnected: boolean
  wsUrl: string
  token: string
  lastError?: string

  // data (latest only)
  snapshot: Snapshot | null
  catalog: CatalogEntry[]
  frame: FrameData | null

  // ui-local
  selectedActor: string | null
  overlay: { boxes: boolean; labels: boolean; active: boolean }
  events: EventEntry[]

  // OPTIMISTIC UI (standing rule): controls update instantly; the snapshot reconciles.
  optimistic: Record<string, Optimistic> // scalar controls keyed by snapshot path
  pendingInjects: PendingInject[] // injects shown immediately until active[] confirms
  pendingReverts: PendingRevert[] // reverts hidden immediately until active[] confirms

  // setters
  setConn: (c: ConnState, err?: string) => void
  setCreds: (wsUrl: string, token: string) => void
  setSnapshot: (s: Snapshot) => void
  setCatalog: (c: CatalogEntry[]) => void
  setFrame: (f: FrameData) => void
  selectActor: (name: string | null) => void
  toggleOverlay: (k: 'boxes' | 'labels' | 'active') => void
  pushEvent: (kind: string, text: string) => void
  setOptimistic: (path: string, value: unknown, ttlMs?: number) => void
  addPendingInject: (id: string, target: string, source?: string) => void
  addPendingReverts: (ids: string[]) => void
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
  selectedActor: null,
  overlay: { boxes: true, labels: true, active: true },
  events: [],
  optimistic: {},
  pendingInjects: [],
  pendingReverts: [],

  setConn: (c, err) =>
    set((st) => ({ conn: c, lastError: err, everConnected: st.everConnected || c === 'connected' })),
  setCreds: (wsUrl, token) => set({ wsUrl, token }),

  setSnapshot: (s) =>
    set((st) => {
      const now = Date.now()
      // Reconcile optimistic scalars: drop once the snapshot confirms the value, or after the TTL.
      const optimistic: Record<string, Optimistic> = {}
      for (const [path, e] of Object.entries(st.optimistic)) {
        if (now <= e.until && resolvePath(s, path) !== e.value) optimistic[path] = e
      }
      // Reconcile the active overlay.
      const activeIds = new Set(s.active.map((a) => a.id))
      const pendingInjects = st.pendingInjects.filter((p) => !activeIds.has(p.id) && now - p.at < ACTIVE_TTL)
      const pendingReverts = st.pendingReverts.filter((r) => activeIds.has(r.id) && now - r.at < ACTIVE_TTL)
      return { snapshot: s, optimistic, pendingInjects, pendingReverts }
    }),

  setCatalog: (c) => set({ catalog: c }),
  setFrame: (f) => {
    const prev = get().frame
    if (prev?.bitmap) prev.bitmap.close()
    set({ frame: f })
  },
  selectActor: (name) => set({ selectedActor: name }),
  toggleOverlay: (k) => set((st) => ({ overlay: { ...st.overlay, [k]: !st.overlay[k] } })),
  pushEvent: (kind, text) =>
    set((st) => ({ events: [...st.events.slice(-(MAX_EVENTS - 1)), { t: Date.now(), kind, text }] })),

  setOptimistic: (path, value, ttlMs = OPT_TTL) =>
    set((st) => ({ optimistic: { ...st.optimistic, [path]: { value, until: Date.now() + ttlMs } } })),
  addPendingInject: (id, target, source = 'manual') =>
    set((st) => ({ pendingInjects: [...st.pendingInjects.filter((p) => p.id !== id), { id, target, source, at: Date.now() }] })),
  addPendingReverts: (ids) =>
    set((st) => {
      const now = Date.now()
      const have = new Set(st.pendingReverts.map((r) => r.id))
      const add = ids.filter((id) => !have.has(id)).map((id) => ({ id, at: now }))
      return { pendingReverts: [...st.pendingReverts, ...add] }
    }),

  hardReset: () => {
    const prev = get().frame
    if (prev?.bitmap) prev.bitmap.close()
    set({
      conn: 'disconnected', everConnected: false, snapshot: null, frame: null, catalog: [],
      selectedActor: null, optimistic: {}, pendingInjects: [], pendingReverts: [],
    })
  },
}))

// Optimistic-aware read: the optimistic value (if pending) else the snapshot fallback.
export function useControlValue<T>(path: string, fallback: T): T {
  const opt = useStore((s) => s.optimistic[path])
  return opt !== undefined ? (opt.value as T) : fallback
}
