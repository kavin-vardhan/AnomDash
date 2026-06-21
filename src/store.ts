import { create } from 'zustand'
import type { Snapshot, CatalogEntry, FrameData, ConnState, EventEntry } from './types'

const MAX_EVENTS = 300

interface AppState {
  // connection
  conn: ConnState
  everConnected: boolean // once true, keep the dashboard mounted across reconnects
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

  // setters (called by the transport + UI)
  setConn: (c: ConnState, err?: string) => void
  setCreds: (wsUrl: string, token: string) => void
  setSnapshot: (s: Snapshot) => void
  setCatalog: (c: CatalogEntry[]) => void
  setFrame: (f: FrameData) => void
  selectActor: (name: string | null) => void
  toggleOverlay: (k: 'boxes' | 'labels' | 'active') => void
  pushEvent: (kind: string, text: string) => void
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

  setConn: (c, err) =>
    set((st) => ({ conn: c, lastError: err, everConnected: st.everConnected || c === 'connected' })),
  setCreds: (wsUrl, token) => set({ wsUrl, token }),
  setSnapshot: (s) => set({ snapshot: s }),
  setCatalog: (c) => set({ catalog: c }),
  setFrame: (f) => {
    const prev = get().frame
    if (prev?.bitmap) prev.bitmap.close() // free the previous ImageBitmap (memory; ~10 Hz)
    set({ frame: f })
  },
  selectActor: (name) => set({ selectedActor: name }),
  toggleOverlay: (k) => set((st) => ({ overlay: { ...st.overlay, [k]: !st.overlay[k] } })),
  pushEvent: (kind, text) =>
    set((st) => ({ events: [...st.events.slice(-(MAX_EVENTS - 1)), { t: Date.now(), kind, text }] })),
  hardReset: () => {
    const prev = get().frame
    if (prev?.bitmap) prev.bitmap.close()
    set({ conn: 'disconnected', everConnected: false, snapshot: null, frame: null, catalog: [], selectedActor: null })
  },
}))
