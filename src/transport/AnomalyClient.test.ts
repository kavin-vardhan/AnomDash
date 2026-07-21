import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnomalyClient } from './AnomalyClient'
import { useStore } from '../store'

const initialState = { ...useStore.getState() }

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  url: string
  binaryType = ''
  readyState = 0
  sent: string[] = []
  closeCalled = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closeCalled = true
  }
  serverOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  serverJson(obj: unknown) {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(obj)).buffer })
  }
  serverBinary(buf: ArrayBuffer) {
    this.onmessage?.({ data: buf })
  }
  serverClose() {
    this.readyState = 3
    this.onclose?.()
  }
  sentTypes(): string[] {
    return this.sent.map((s) => JSON.parse(s).type as string)
  }
}

interface BitmapDeferred {
  resolve: (b: ImageBitmap) => void
}

let bitmapQueue: BitmapDeferred[] = []

function makeBitmap() {
  return { close: vi.fn() } as unknown as ImageBitmap
}

function closeSpy(b: ImageBitmap) {
  return b.close as unknown as ReturnType<typeof vi.fn>
}

function frameBytes(frameId: number, epoch: number): ArrayBuffer {
  const buf = new ArrayBuffer(24)
  const u8 = new Uint8Array(buf)
  u8.set([0x41, 0x49, 0x46, 0x31], 0)
  const dv = new DataView(buf)
  dv.setUint32(4, frameId, true)
  dv.setUint32(8, epoch, true)
  dv.setUint16(12, 960, true)
  dv.setUint16(14, 540, true)
  return buf
}

async function drain() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function openAndWelcome(c: AnomalyClient): FakeWebSocket {
  c.connect('ws://127.0.0.1:8077', 'TOK')
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  ws.serverOpen()
  ws.serverJson({ type: 'welcome', v: 1 })
  return ws
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  bitmapQueue = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise<ImageBitmap>((resolve) => {
    bitmapQueue.push({ resolve })
  })))
  useStore.setState({ ...initialState }, true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('auth failure', () => {
  it('explicit bad_token error → auth_failed, socket closed, no auto-retry', () => {
    const c = new AnomalyClient()
    c.connect('ws://127.0.0.1:8077', 'WRONG')
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'hello', token: 'WRONG' })
    ws.serverJson({ type: 'error', code: 'bad_token', message: 'token rejected' })
    expect(useStore.getState().conn).toBe('auth_failed')
    expect(ws.closeCalled).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('no reply to hello → auth_failed at the timeout, no auto-retry', () => {
    const c = new AnomalyClient()
    c.connect('ws://127.0.0.1:8077', 'WRONG')
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    vi.advanceTimersByTime(4000)
    expect(useStore.getState().conn).toBe('auth_failed')
    expect(ws.closeCalled).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('welcome in time clears the auth timer and connects', () => {
    const c = new AnomalyClient()
    const ws = openAndWelcome(c)
    expect(useStore.getState().conn).toBe('connected')
    expect(ws.sentTypes()).toContain('subscribe')
    expect(ws.sentTypes()).toContain('list_anomalies')
    vi.advanceTimersByTime(30_000)
    expect(useStore.getState().conn).toBe('connected')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a bad_token error after authentication is ignored', () => {
    const c = new AnomalyClient()
    const ws = openAndWelcome(c)
    ws.serverJson({ type: 'error', code: 'bad_token' })
    expect(useStore.getState().conn).toBe('connected')
  })
})

describe('reconnect races', () => {
  it('a stale socket closing does not clobber the live socket', () => {
    const c = new AnomalyClient()
    c.connect('ws://127.0.0.1:8077', 'TOK')
    const a = FakeWebSocket.instances[0]
    a.serverOpen()
    a.serverJson({ type: 'welcome', v: 1 })
    expect(useStore.getState().conn).toBe('connected')
    c.reconnect()
    expect(a.closeCalled).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const b = FakeWebSocket.instances[1]
    a.serverClose()
    expect(useStore.getState().conn).toBe('connecting')
    b.serverOpen()
    b.serverJson({ type: 'welcome', v: 1 })
    expect(useStore.getState().conn).toBe('connected')
    expect(c.send({ type: 'ping' })).toBe(true)
    expect(b.sentTypes()).toContain('ping')
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('a pending backoff timer is cancelled by a manual connect', () => {
    const c = new AnomalyClient()
    const a = openAndWelcome(c)
    a.serverClose()
    expect(useStore.getState().conn).toBe('disconnected')
    c.connect('ws://127.0.0.1:8077', 'TOK')
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('an unintentional close schedules exactly one backoff reconnect', () => {
    const c = new AnomalyClient()
    const a = openAndWelcome(c)
    a.serverClose()
    expect(useStore.getState().conn).toBe('disconnected')
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('disconnect cancels the backoff chain entirely', () => {
    const c = new AnomalyClient()
    const a = openAndWelcome(c)
    a.serverClose()
    c.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(useStore.getState().conn).toBe('disconnected')
  })
})

describe('preview frame ordering', () => {
  it('a slow decode of an older frame cannot overwrite a newer one', async () => {
    const c = new AnomalyClient()
    const ws = openAndWelcome(c)
    ws.serverBinary(frameBytes(1, 7))
    ws.serverBinary(frameBytes(2, 7))
    expect(bitmapQueue).toHaveLength(2)
    const b1 = makeBitmap()
    const b2 = makeBitmap()
    bitmapQueue[1].resolve(b2)
    await drain()
    expect(useStore.getState().frame?.frameId).toBe(2)
    bitmapQueue[0].resolve(b1)
    await drain()
    expect(useStore.getState().frame?.frameId).toBe(2)
    expect(closeSpy(b1)).toHaveBeenCalledTimes(1)
    expect(closeSpy(b2)).not.toHaveBeenCalled()
  })

  it('an epoch change accepts a lower frameId', async () => {
    const c = new AnomalyClient()
    const ws = openAndWelcome(c)
    ws.serverBinary(frameBytes(100, 7))
    bitmapQueue[0].resolve(makeBitmap())
    await drain()
    expect(useStore.getState().frame?.frameId).toBe(100)
    ws.serverBinary(frameBytes(3, 8))
    bitmapQueue[1].resolve(makeBitmap())
    await drain()
    expect(useStore.getState().frame?.frameId).toBe(3)
    expect(useStore.getState().frame?.epoch).toBe(8)
  })

  it('a frame decoded after its socket died is dropped and closed', async () => {
    const c = new AnomalyClient()
    const ws = openAndWelcome(c)
    ws.serverBinary(frameBytes(1, 7))
    const b = makeBitmap()
    c.disconnect()
    bitmapQueue[0].resolve(b)
    await drain()
    expect(useStore.getState().frame).toBeNull()
    expect(closeSpy(b)).toHaveBeenCalledTimes(1)
  })
})
