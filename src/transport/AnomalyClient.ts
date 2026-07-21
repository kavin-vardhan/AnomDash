import { useStore } from '../store'
import type { Snapshot, CatalogEntry } from '../types'
import { isFrameBytes, parseFrameHeader, frameJpegSlice, PROTOCOL_VERSION } from './protocol'

const AUTH_TIMEOUT_MS = 4000

export class AnomalyClient {
  private ws: WebSocket | null = null
  private url = ''
  private token = ''
  private reconnectDelay = 500
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false

  private snapshotHz = 5
  private frameHz = 6
  private lastCaptureRunning = false
  private lastFrameEpoch = -1
  private lastFrameId = -1

  connect(url: string, token: string) {
    this.url = url
    this.token = token
    this.intentionalClose = false
    this.reconnectDelay = 500
    this.clearReconnectTimer()
    this.clearAuthTimer()
    this.closeSocket()
    this.open()
  }

  disconnect() {
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.clearAuthTimer()
    this.closeSocket()
    useStore.getState().hardReset()
  }

  reconnect() {
    if (!this.url) return
    this.connect(this.url, this.token)
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearAuthTimer() {
    if (this.authTimer) {
      clearTimeout(this.authTimer)
      this.authTimer = null
    }
  }

  private closeSocket() {
    const ws = this.ws
    this.ws = null
    if (ws) {
      try { ws.close() } catch {   }
    }
  }

  private failAuth(reason: string) {
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.clearAuthTimer()
    this.closeSocket()
    useStore.getState().setConn('auth_failed', reason)
  }

  private subscribe(withFrames: boolean) {
    this.send({
      type: 'subscribe',
      channels: withFrames ? ['snapshot', 'frames'] : ['snapshot'],
      snapshotHz: this.snapshotHz,
      frameHz: this.frameHz,
    })
  }

  private open() {
    useStore.getState().setConn('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      useStore.getState().setConn('authenticating')
      this.send({ type: 'hello', token: this.token, v: PROTOCOL_VERSION })
      this.clearAuthTimer()
      this.authTimer = setTimeout(() => {
        if (this.ws !== ws) return
        this.failAuth('no reply to authentication — wrong token, or the server is unresponsive')
      }, AUTH_TIMEOUT_MS)
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      this.onMessage(ev, ws)
    }
    ws.onerror = () => {   }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearAuthTimer()
      if (this.intentionalClose) return
      useStore.getState().setConn('disconnected', 'connection closed')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000)
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) this.open()
    }, delay)
  }

  private onMessage(ev: MessageEvent, sock: WebSocket) {
    let bytes: Uint8Array
    if (typeof ev.data === 'string') {
      bytes = new TextEncoder().encode(ev.data)
    } else {
      bytes = new Uint8Array(ev.data as ArrayBuffer)
    }

    if (isFrameBytes(bytes)) {
      const h = parseFrameHeader(bytes)
      const blob = new Blob([new Uint8Array(frameJpegSlice(bytes))], { type: 'image/jpeg' })
      createImageBitmap(blob)
        .then((bitmap) => {
          const stale = this.ws !== sock || (h.epoch === this.lastFrameEpoch && h.frameId <= this.lastFrameId)
          if (stale) {
            bitmap.close()
            return
          }
          this.lastFrameEpoch = h.epoch
          this.lastFrameId = h.frameId
          useStore.getState().setFrame({ bitmap, frameId: h.frameId, epoch: h.epoch, w: h.w, h: h.h })
        })
        .catch(() => {   })
      return
    }

    let msg: any
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return
    }
    this.dispatch(msg)
  }

  private dispatch(msg: any) {
    const s = useStore.getState()
    switch (msg?.type) {
      case 'welcome':
        this.clearAuthTimer()
        s.setConn('connected')
        this.reconnectDelay = 500
        this.lastCaptureRunning = false
        this.lastFrameEpoch = -1
        this.lastFrameId = -1
        this.subscribe(true)
        this.send({ type: 'list_anomalies' })
        break
      case 'error':
        if (msg?.code === 'bad_token' && s.conn === 'authenticating') {
          this.failAuth('token rejected by server')
        }
        break
      case 'snapshot': {
        s.setSnapshot(msg as Snapshot)
        const capRunning = !!(msg.capture && msg.capture.running)
        if (capRunning !== this.lastCaptureRunning) {
          this.lastCaptureRunning = capRunning
          this.subscribe(!capRunning)
        }
        break
      }
      case 'catalog':
        s.setCatalog((msg.entries ?? []) as CatalogEntry[])
        break
      case 'capture_stopped':
        s.setCaptureStopped({
          runDir: msg.runDir ?? '', sessionId: msg.sessionId ?? '', frames: Number(msg.frames ?? 0), maxFrames: Number(msg.maxFrames ?? 0), seed: Number(msg.seed ?? 0), at: Date.now(),
          targetFps: typeof msg.targetFps === 'number' ? msg.targetFps : undefined,
          stampedFps: typeof msg.stampedFps === 'number' ? msg.stampedFps : undefined,
          speedRatio: typeof msg.speedRatio === 'number' ? msg.speedRatio : undefined,
          paced: typeof msg.paced === 'boolean' ? msg.paced : undefined,
        })
        break
      default:
        break
    }
  }

  send(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
      return true
    }
    const type = obj && typeof obj === 'object' && 'type' in obj ? String((obj as { type?: unknown }).type) : '?'
    useStore.getState().pushEvent('system', `command not sent (${type}) — not connected`)
    return false
  }

  revert(anomaly: string) { return this.send({ type: 'revert', anomaly }) }
  revertAll() { return this.send({ type: 'revert_all' }) }
  setViewportScoping(enabled: boolean) { return this.send({ type: 'set_viewport_scoping', enabled }) }
  setHud(which: 'selector' | 'auto', enabled: boolean) { return this.send({ type: 'set_hud', which, enabled }) }
  setPollRadius(cm: number) { return this.send({ type: 'set_poll_radius', cm }) }
  setMinScreenCoverage(pct: number) { return this.send({ type: 'set_min_screen_coverage', pct }) }
  autoConfig(cfg: Record<string, unknown>) { return this.send({ type: 'auto_config', ...cfg }) }
  captureStart(opts: Record<string, unknown>) { return this.send({ type: 'capture_start', ...opts }) }
  captureStop() { return this.send({ type: 'capture_stop' }) }
}

export const client = new AnomalyClient()
