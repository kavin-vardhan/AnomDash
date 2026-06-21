import { useStore } from '../store'
import type { Snapshot, CatalogEntry } from '../types'
import { isFrameBytes, parseFrameHeader, frameJpegSlice, PROTOCOL_VERSION } from './protocol'

// One WebSocket to the in-game control server. Framing-agnostic decode (binary => sniff "AIF1" magic, else
// UTF-8 JSON), connect/auth/subscribe flow, exponential-backoff reconnect, and command helpers. The transport
// writes to the Zustand store imperatively; React panels read from the store.
class AnomalyClient {
  private ws: WebSocket | null = null
  private url = ''
  private token = ''
  private reconnectDelay = 500
  private intentionalClose = false

  // subscribe cadence (server clamps snapshot<=20, frame<=10)
  private snapshotHz = 5
  private frameHz = 6
  private lastCaptureRunning = false // to drop preview frames while a capture run owns the viewport

  connect(url: string, token: string) {
    this.url = url
    this.token = token
    this.intentionalClose = false
    this.reconnectDelay = 500
    this.open()
  }

  disconnect() {
    this.intentionalClose = true
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    useStore.getState().hardReset()
  }

  // Force a fresh connection — for a stalled-but-open socket (no close event) the auto-reconnect never fires,
  // so the user can re-establish the stream manually.
  reconnect() {
    if (!this.url) return
    this.intentionalClose = false
    this.reconnectDelay = 500
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    this.open()
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
      useStore.getState().setConn('authenticating')
      this.send({ type: 'hello', token: this.token, v: PROTOCOL_VERSION })
    }
    ws.onmessage = (ev) => this.onMessage(ev)
    ws.onerror = () => { /* onclose handles recovery */ }
    ws.onclose = () => {
      this.ws = null
      if (this.intentionalClose) return
      // Keep everConnected so the dashboard stays mounted with a reconnecting banner.
      useStore.getState().setConn('disconnected', 'connection closed')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000)
    setTimeout(() => { if (!this.intentionalClose) this.open() }, delay)
  }

  private onMessage(ev: MessageEvent) {
    let bytes: Uint8Array
    if (typeof ev.data === 'string') {
      bytes = new TextEncoder().encode(ev.data) // defensive: a text opcode would still be JSON
    } else {
      bytes = new Uint8Array(ev.data as ArrayBuffer)
    }

    if (isFrameBytes(bytes)) {
      const h = parseFrameHeader(bytes)
      // Copy the JPEG slice into a fresh ArrayBuffer-backed Uint8Array (a subarray view types as
      // Uint8Array<ArrayBufferLike>, which the DOM lib won't accept as a BlobPart).
      const blob = new Blob([new Uint8Array(frameJpegSlice(bytes))], { type: 'image/jpeg' })
      createImageBitmap(blob)
        .then((bitmap) => useStore.getState().setFrame({ bitmap, frameId: h.frameId, epoch: h.epoch, w: h.w, h: h.h }))
        .catch(() => { /* drop a bad frame */ })
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
        s.setConn('connected') // derives the readable "connected"/"restored" event
        this.reconnectDelay = 500
        this.lastCaptureRunning = false
        this.subscribe(true)
        this.send({ type: 'list_anomalies' })
        break
      case 'snapshot': {
        s.setSnapshot(msg as Snapshot)
        // Load mitigation: while a capture run owns the viewport, drop the preview frames — their per-cycle
        // ReadPixels is redundant (capture is writing frames to disk) and doubles the render-flush stall that
        // starves the snapshot stream. Re-subscribe to frames when capture stops.
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
        s.setCaptureStopped({ runDir: msg.runDir ?? '', frames: Number(msg.frames ?? 0), seed: Number(msg.seed ?? 0), at: Date.now() })
        break
      // ack / capture_status / other replies carry no user-facing text; the readable activity log is
      // derived from snapshot deltas (see store.deriveSnapshotEvents).
      default:
        break
    }
  }

  // Returns true if the command went out, false if dropped (socket not OPEN) — a dropped command logs a
  // visible error and (per the call sites) does NOT set an optimistic "success", so the UI never lies.
  send(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
      return true
    }
    const type = obj && typeof obj === 'object' && 'type' in obj ? String((obj as { type?: unknown }).type) : '?'
    useStore.getState().pushEvent('system', `command not sent (${type}) — not connected`)
    return false
  }

  // --- command helpers (return whether the command was actually sent) ---
  listAnomalies() { return this.send({ type: 'list_anomalies' }) }
  inject(anomaly: string, target: string, args: string[]) { return this.send({ type: 'inject', anomaly, target, args }) }
  revert(anomaly: string) { return this.send({ type: 'revert', anomaly }) }
  revertAll() { return this.send({ type: 'revert_all' }) }
  setViewportScoping(enabled: boolean) { return this.send({ type: 'set_viewport_scoping', enabled }) }
  setHud(which: 'selector' | 'auto', enabled: boolean) { return this.send({ type: 'set_hud', which, enabled }) }
  requestFrame() { return this.send({ type: 'request_frame' }) }
  setPollRadius(cm: number) { return this.send({ type: 'set_poll_radius', cm }) }
  autoConfig(cfg: Record<string, unknown>) { return this.send({ type: 'auto_config', ...cfg }) }
  autoRun(running: boolean) { return this.send({ type: 'auto_run', running }) }
  autoStep(seconds: number) { return this.send({ type: 'auto_step', seconds }) }
  autoFireOnce() { return this.send({ type: 'auto_fire_once' }) }
  captureStart(opts: Record<string, unknown>) { return this.send({ type: 'capture_start', ...opts }) }
  captureStop() { return this.send({ type: 'capture_stop' }) }
  captureStatus() { return this.send({ type: 'capture_status' }) }
}

export const client = new AnomalyClient()
