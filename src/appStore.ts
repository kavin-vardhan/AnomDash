import { create } from 'zustand'
import type { AppSettings, Discovery, GenerateProgress, SessionInfo } from './backend'

export type View = 'capture' | 'library' | 'settings'

export interface OutputChoice {
  video: boolean
  masks: boolean
  previews: boolean
}

export interface JobState {
  step: GenerateProgress['step']
  state: GenerateProgress['state']
  done: number
  total: number
  message: string
}

export interface CaptureForm {
  mode: 'auto' | 'targeted'
  anomalyId: string
  frames: string
  format: 'png' | 'jpeg'
  outputHeight: string
  seed: string
}

interface AppState {
  form: CaptureForm
  setForm: (patch: Partial<CaptureForm>) => void
  view: View
  settings: AppSettings | null
  discovery: Discovery | null
  sessions: SessionInfo[]
  sessionsLoaded: boolean
  selected: Record<string, boolean>
  outputs: OutputChoice
  generating: boolean
  jobs: Record<string, JobState>
  justSaved: { sessionId: string; at: number } | null

  setView: (v: View) => void
  setSettings: (s: AppSettings) => void
  setDiscovery: (d: Discovery) => void
  setSessions: (s: SessionInfo[]) => void
  toggleSelected: (path: string) => void
  setSelected: (paths: string[], on: boolean) => void
  clearSelection: () => void
  setOutput: (k: keyof OutputChoice, on: boolean) => void
  setGenerating: (on: boolean) => void
  applyProgress: (p: GenerateProgress) => void
  clearJobs: () => void
  setJustSaved: (sessionId: string | null) => void
}

export const useApp = create<AppState>((set) => ({
  form: { mode: 'auto', anomalyId: '', frames: '300', format: 'png', outputHeight: '', seed: '' },
  setForm: (patch) => set((st) => ({ form: { ...st.form, ...patch } })),
  view: 'capture',
  settings: null,
  discovery: null,
  sessions: [],
  sessionsLoaded: false,
  selected: {},
  outputs: { video: true, masks: true, previews: false },
  generating: false,
  jobs: {},
  justSaved: null,

  setView: (v) => set({ view: v }),
  setSettings: (s) => set({ settings: s }),
  setDiscovery: (d) => set({ discovery: d }),
  setSessions: (s) =>
    set((st) => {
      const keep: Record<string, boolean> = {}
      for (const x of s) if (st.selected[x.path]) keep[x.path] = true
      return { sessions: s, sessionsLoaded: true, selected: keep }
    }),
  toggleSelected: (path) =>
    set((st) => {
      const next = { ...st.selected }
      if (next[path]) delete next[path]
      else next[path] = true
      return { selected: next }
    }),
  setSelected: (paths, on) =>
    set((st) => {
      const next = { ...st.selected }
      for (const p of paths) {
        if (on) next[p] = true
        else delete next[p]
      }
      return { selected: next }
    }),
  clearSelection: () => set({ selected: {} }),
  setOutput: (k, on) => set((st) => ({ outputs: { ...st.outputs, [k]: on } })),
  setGenerating: (on) => set({ generating: on }),
  applyProgress: (p) =>
    set((st) => ({
      jobs: { ...st.jobs, [p.session]: { step: p.step, state: p.state, done: p.done, total: p.total, message: p.message } },
    })),
  clearJobs: () => set({ jobs: {} }),
  setJustSaved: (sessionId) => set({ justSaved: sessionId ? { sessionId, at: Date.now() } : null }),
}))
