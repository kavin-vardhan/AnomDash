import { create } from 'zustand'
import { useStore } from './store'

export interface TapeSegment {
  key: string
  id: string
  target: string
  start: number
  end: number
}

interface TapeState {
  running: boolean
  startedAt: number
  segments: TapeSegment[]
  frames: number
  maxFrames: number
}

export const useTape = create<TapeState>(() => ({ running: false, startedAt: 0, segments: [], frames: 0, maxFrames: 0 }))

let open = new Map<string, TapeSegment>()
let started = false

export function startRecorder() {
  if (started) return
  started = true
  useStore.subscribe((s, prev) => {
    const cap = s.snapshot?.capture
    const was = prev.snapshot?.capture?.running ?? false
    if (!cap) return
    if (cap.running && !was) {
      open = new Map()
      useTape.setState({ running: true, startedAt: Date.now(), segments: [], frames: 0, maxFrames: cap.maxFrames })
    }
    if (!cap.running && was) {
      open = new Map()
      useTape.setState({ running: false, frames: prev.snapshot?.capture.framesWritten ?? cap.framesWritten })
      return
    }
    if (!cap.running || s.snapshot === prev.snapshot) return
    const frame = cap.framesWritten
    const seen = new Set<string>()
    const segs = [...useTape.getState().segments]
    let changed = false
    for (const a of s.snapshot!.active) {
      const key = `${a.id}|${a.target}`
      seen.add(key)
      const cur = open.get(key)
      if (cur) {
        if (cur.end !== frame) {
          cur.end = frame
          changed = true
        }
      } else if (frame > 0) {
        const seg = { key: `${key}|${frame}`, id: a.id, target: a.target, start: frame, end: frame }
        open.set(key, seg)
        segs.push(seg)
        changed = true
      }
    }
    for (const k of [...open.keys()]) {
      if (!seen.has(k)) {
        open.delete(k)
        changed = true
      }
    }
    useTape.setState({ frames: frame, maxFrames: cap.maxFrames, ...(changed ? { segments: segs.map((x) => ({ ...x })) } : {}) })
  })
}
