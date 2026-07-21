import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStore, keepOptimistic } from './store'
import type { Snapshot, ActiveAnomaly, FrameData } from './types'

const initialState = { ...useStore.getState() }

const T0 = new Date('2026-07-21T12:00:00Z').getTime()

function makeSnapshot(mut?: (s: Snapshot) => void): Snapshot {
  const s: Snapshot = {
    v: 1,
    type: 'snapshot',
    t: 0,
    epoch: 1,
    view: { origin: [0, 0, 0], rot: [0, 0, 0], fovDeg: 90, aspect: 1.777, viewportPx: [1280, 720], valid: true },
    visible: [],
    active: [],
    auto: {
      enabled: false, running: false, seed: 0,
      intervalMin: 4, intervalMax: 9, holdMin: 3, holdMax: 6,
      maxConcurrent: 3, persist: false, pool: {}, liveFires: [],
    },
    session: {
      viewportScoping: false, selectorHud: false, autoHud: false,
      fps: 60, activeCount: 0, pollRadius: 15, minScreenCoverage: 6,
    },
    capture: {
      running: false, framesWritten: 0, maxFrames: 0, framesRemaining: 0,
      runDir: '', sessionId: '', seed: 0,
    },
  }
  if (mut) mut(s)
  return s
}

function makeActive(id: string, source: string, target = 'SM_Ramp2'): ActiveAnomaly {
  return { id, target, args: [], source, tActive: 1.0 }
}

function makeBitmap() {
  return { close: vi.fn() } as unknown as ImageBitmap
}

function snapRadius(cm: number) {
  useStore.getState().setSnapshot(makeSnapshot((s) => { s.session.pollRadius = cm }))
}

const PATH = 'session.pollRadius'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  useStore.setState({ ...initialState }, true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('keepOptimistic (pure)', () => {
  const e = { value: 2500, baseline: 15, until: 10_000 }

  it('drops on CONFIRM (cur === value)', () => {
    expect(keepOptimistic(e, 2500, 15, 5000)).toBe(false)
  })

  it('keeps while the snapshot still carries the old value (cur === baseline)', () => {
    expect(keepOptimistic(e, 15, 15, 5000)).toBe(true)
  })

  it('drops on SETTLE (moved off baseline and stable across two snapshots)', () => {
    expect(keepOptimistic(e, 20000, 20000, 5000)).toBe(false)
  })

  it('keeps while the field is progressing (moved but not yet stable)', () => {
    expect(keepOptimistic(e, 20000, 15, 5000)).toBe(true)
  })

  it('drops past the absolute backstop', () => {
    expect(keepOptimistic(e, 15, 15, 10_001)).toBe(false)
  })
})

describe('optimism through the store (m13 gates)', () => {
  it('G1 normal cadence: held through a stale snapshot, dropped on confirm', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 2500)
    expect(useStore.getState().optimistic[PATH]).toMatchObject({ value: 2500, baseline: 15 })
    snapRadius(15)
    expect(useStore.getState().optimistic[PATH]).toBeDefined()
    snapRadius(2500)
    expect(useStore.getState().optimistic[PATH]).toBeUndefined()
    expect(useStore.getState().snapshot?.session.pollRadius).toBe(2500)
  })

  it('G2 slow cadence: held across 40 consecutive stale snapshots, no snapback', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 2500)
    for (let i = 0; i < 40; i++) snapRadius(15)
    expect(useStore.getState().optimistic[PATH]).toMatchObject({ value: 2500 })
  })

  it('G2b supersede: a late snapshot of a superseded value does not resurrect it', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 2500)
    useStore.getState().setOptimistic(PATH, 3000)
    snapRadius(2500)
    expect(useStore.getState().optimistic[PATH]).toMatchObject({ value: 3000 })
    snapRadius(3000)
    expect(useStore.getState().optimistic[PATH]).toBeUndefined()
  })

  it('settles to a superseded value the server holds stable across two snapshots', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 3000)
    snapRadius(2500)
    expect(useStore.getState().optimistic[PATH]).toBeDefined()
    snapRadius(2500)
    expect(useStore.getState().optimistic[PATH]).toBeUndefined()
  })

  it('G4 clamp: resolves to the server-clamped value once stable', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 25000)
    snapRadius(20000)
    expect(useStore.getState().optimistic[PATH]).toBeDefined()
    snapRadius(20000)
    expect(useStore.getState().optimistic[PATH]).toBeUndefined()
  })

  it('G5 disconnect clears optimism and pending reverts', () => {
    useStore.getState().setConn('connected')
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    useStore.getState().setOptimistic(PATH, 2500)
    useStore.getState().addPendingReverts(['blinking'])
    useStore.getState().setConn('disconnected')
    expect(useStore.getState().optimistic).toEqual({})
    expect(useStore.getState().pendingReverts).toEqual([])
  })

  it('backstop: tick() prunes an entry past 10s', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 2500)
    vi.setSystemTime(T0 + 10_001)
    useStore.getState().tick()
    expect(useStore.getState().optimistic[PATH]).toBeUndefined()
  })

  it('backstop: a stale snapshot past 10s also drops the entry', () => {
    useStore.getState().setConn('connected')
    snapRadius(15)
    useStore.getState().setOptimistic(PATH, 2500)
    vi.setSystemTime(T0 + 10_001)
    snapRadius(15)
    expect(useStore.getState().optimistic[PATH]).toBeUndefined()
  })
})

describe('pendingReverts reconciliation', () => {
  it('kept while the id is still active and fresh', () => {
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    useStore.getState().addPendingReverts(['blinking'])
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    expect(useStore.getState().pendingReverts).toHaveLength(1)
  })

  it('removed once the id leaves the active set', () => {
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    useStore.getState().addPendingReverts(['blinking'])
    useStore.getState().setSnapshot(makeSnapshot())
    expect(useStore.getState().pendingReverts).toHaveLength(0)
  })

  it('expires at the 3s TTL even if the id is still active', () => {
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    useStore.getState().addPendingReverts(['blinking'])
    vi.setSystemTime(T0 + 3001)
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    expect(useStore.getState().pendingReverts).toHaveLength(0)
  })
})

describe('snapshot-diff events', () => {
  function lastEvent() {
    const ev = useStore.getState().events
    return ev[ev.length - 1]
  }

  it('first snapshot (no prev) derives no events', () => {
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    expect(useStore.getState().events).toHaveLength(0)
  })

  it('auto fire and auto-revert derive auto events', () => {
    useStore.getState().setSnapshot(makeSnapshot())
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('blinking', 'auto')] }))
    expect(lastEvent()).toMatchObject({ kind: 'auto', text: 'auto fired blinking on SM_Ramp2' })
    useStore.getState().setSnapshot(makeSnapshot())
    expect(lastEvent()).toMatchObject({ kind: 'auto', text: 'blinking auto-reverted' })
  })

  it('manual inject and revert derive inject events', () => {
    useStore.getState().setSnapshot(makeSnapshot())
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.active = [makeActive('missing_object', 'manual')] }))
    expect(lastEvent()).toMatchObject({ kind: 'inject', text: 'injected missing_object on SM_Ramp2' })
    useStore.getState().setSnapshot(makeSnapshot())
    expect(lastEvent()).toMatchObject({ kind: 'inject', text: 'reverted missing_object' })
  })

  it('capture running flips derive start and stop events', () => {
    useStore.getState().setSnapshot(makeSnapshot())
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.capture.running = true }))
    expect(lastEvent()).toMatchObject({ kind: 'capture', text: 'capture started' })
    useStore.getState().setSnapshot(makeSnapshot((s) => { s.capture.framesWritten = 120 }))
    expect(lastEvent()).toMatchObject({ kind: 'capture', text: 'capture complete (120 frames saved)' })
  })

  it('setCaptureStopped records state and appends its own event', () => {
    useStore.getState().setCaptureStopped({ runDir: 'x/session_1', sessionId: 'session_1', frames: 120, maxFrames: 120, seed: 7, at: T0 })
    expect(useStore.getState().lastCaptureStopped?.frames).toBe(120)
    expect(lastEvent()).toMatchObject({ kind: 'capture', text: 'run complete — 120 frames saved' })
  })

  it('event log is capped at 300 entries', () => {
    for (let i = 0; i < 305; i++) useStore.getState().pushEvent('system', `e${i}`)
    expect(useStore.getState().events).toHaveLength(300)
    expect(useStore.getState().events[299].text).toBe('e304')
  })

  it('connection transitions log connect, loss, and restore', () => {
    useStore.getState().setConn('connected')
    expect(lastEvent()).toMatchObject({ kind: 'system', text: 'connected to server' })
    useStore.getState().setConn('disconnected')
    expect(lastEvent()).toMatchObject({ kind: 'system', text: 'connection lost — reconnecting…' })
    useStore.getState().setConn('connected')
    expect(lastEvent()).toMatchObject({ kind: 'system', text: 'connection restored' })
  })
})

describe('frame lifecycle', () => {
  function frame(bitmap: ImageBitmap, frameId: number): FrameData {
    return { bitmap, frameId, epoch: 1, w: 2, h: 2 }
  }

  it('setFrame closes the previous bitmap', () => {
    const b1 = makeBitmap()
    const b2 = makeBitmap()
    useStore.getState().setFrame(frame(b1, 1))
    useStore.getState().setFrame(frame(b2, 2))
    expect((b1.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    expect((b2.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('hardReset closes the current bitmap and resets state', () => {
    const b = makeBitmap()
    useStore.getState().setConn('connected')
    useStore.getState().setSnapshot(makeSnapshot())
    useStore.getState().setFrame(frame(b, 1))
    useStore.getState().setOptimistic(PATH, 2500)
    useStore.getState().hardReset()
    expect((b.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    const st = useStore.getState()
    expect(st.conn).toBe('disconnected')
    expect(st.everConnected).toBe(false)
    expect(st.snapshot).toBeNull()
    expect(st.frame).toBeNull()
    expect(st.optimistic).toEqual({})
  })
})
