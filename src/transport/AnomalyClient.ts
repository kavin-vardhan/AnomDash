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
        this.send({ type: 'subscribe', channels: ['snapshot', 'frames'], snapshotHz: this.snapshotHz, frameHz: this.frameHz })
        this.send({ type: 'list_anomalies' })
        break
      case 'snapshot':
        s.setSnapshot(msg as Snapshot)
        break
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

  send(obj: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  // --- command helpers (the full server vocabulary; Slice A uses a subset, B/C/D use the rest) ---
  listAnomalies() { this.send({ type: 'list_anomalies' }) }
  inject(anomaly: string, target: string, args: string[]) { this.send({ type: 'inject', anomaly, target, args }) }
  revert(anomaly: string) { this.send({ type: 'revert', anomaly }) }
  revertAll() { this.send({ type: 'revert_all' }) }
  setViewportScoping(enabled: boolean) { this.send({ type: 'set_viewport_scoping', enabled }) }
  setHud(which: 'selector' | 'auto', enabled: boolean) { this.send({ type: 'set_hud', which, enabled }) }
  requestFrame() { this.send({ type: 'request_frame' }) }
  setPollRadius(cm: number) { this.send({ type: 'set_poll_radius', cm }) }
  autoConfig(cfg: Record<string, unknown>) { this.send({ type: 'auto_config', ...cfg }) }
  autoRun(running: boolean) { this.send({ type: 'auto_run', running }) }
  autoStep(seconds: number) { this.send({ type: 'auto_step', seconds }) }
  autoFireOnce() { this.send({ type: 'auto_fire_once' }) }
  captureStart(opts: Record<string, unknown>) { this.send({ type: 'capture_start', ...opts }) }
  captureStop() { this.send({ type: 'capture_stop' }) }
  captureStatus() { this.send({ type: 'capture_status' }) }
}

export const client = new AnomalyClient()
