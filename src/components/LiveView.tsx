import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Eye, EyeOff, CirclePause } from 'lucide-react'
import { useStore } from '../store'
import { useApp } from '../appStore'
import { isNearFullscreen, pickActorAt } from '../lib/geom'
import { displayName } from '../types'
import { anomalyMeta } from '../anomalies'
import { ConnectHelp } from './ConnectHelp'

function fit(c: HTMLCanvasElement, w: number, h: number) {
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
}

export function LiveView() {
  const frame = useStore((s) => s.frame)
  const snapshot = useStore((s) => s.snapshot)
  const conn = useStore((s) => s.conn)
  const selected = useStore((s) => s.selectedActor)
  const selectActor = useStore((s) => s.selectActor)
  const mode = useApp((s) => s.form.mode)
  const [showObjects, setShowObjects] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [lastFrameAt, setLastFrameAt] = useState(0)
  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    if (frame) setLastFrameAt(Date.now())
  }, [frame])
  const [connectedAt, setConnectedAt] = useState(0)
  useEffect(() => {
    if (conn === 'connected') setConnectedAt(Date.now())
  }, [conn])
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const wrap = useRef<HTMLDivElement>(null)
  const frameCanvas = useRef<HTMLCanvasElement>(null)
  const overlayCanvas = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 960, h: 540 })
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1

  const aspect = frame ? frame.w / frame.h : snapshot?.view.aspect && snapshot.view.aspect > 0 ? snapshot.view.aspect : 16 / 9

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      let w = r.width
      let h = w / aspect
      if (h > r.height) {
        h = r.height
        w = h * aspect
      }
      setBox((prev) => (Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5 ? prev : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])

  const bw = Math.max(1, Math.round(box.w * dpr))
  const bh = Math.max(1, Math.round(box.h * dpr))

  useEffect(() => {
    const c = frameCanvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    fit(c, bw, bh)
    if (frame?.bitmap) {
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(frame.bitmap, 0, 0, c.width, c.height)
    } else {
      ctx.fillStyle = '#0B111C'
      ctx.fillRect(0, 0, c.width, c.height)
    }
  }, [frame, bw, bh])

  const targeting = mode === 'targeted'
  const drawObjects = showObjects || targeting

  useEffect(() => {
    const c = overlayCanvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    fit(c, bw, bh)
    ctx.clearRect(0, 0, c.width, c.height)
    if (!snapshot) return
    if (frame && frame.epoch !== snapshot.epoch) return
    const s = dpr
    const activeByTarget = new Map(snapshot.active.filter((a) => a.target).map((a) => [a.target, a.id]))

    const label = (text: string, x: number, y: number, bg: string, fg = '#fff') => {
      const fs = 12 * s
      ctx.font = `600 ${fs}px 'IBM Plex Sans', 'Segoe UI', sans-serif`
      const tw = ctx.measureText(text).width
      const ph = 20 * s
      const px = 7 * s
      const top = Math.max(0, y - ph - 4 * s)
      ctx.fillStyle = bg
      ctx.beginPath()
      ctx.roundRect(x, top, tw + px * 2, ph, 5 * s)
      ctx.fill()
      ctx.fillStyle = fg
      ctx.fillText(text, x + px, top + ph - 6 * s)
    }

    for (const v of snapshot.visible) {
      if (!v.rectValid) continue
      const [x0, y0, x1, y1] = v.rect
      const x = x0 * c.width, y = y0 * c.height, w = (x1 - x0) * c.width, h = (y1 - y0) * c.height
      const near = isNearFullscreen(v.rect)
      const isSel = v.name === selected
      const isHover = v.name === hover
      const activeId = activeByTarget.get(v.name)

      if (activeId) {
        const col = anomalyMeta(activeId).color
        ctx.lineWidth = 2.5 * s
        ctx.strokeStyle = col
        ctx.setLineDash([])
        ctx.strokeRect(x, y, w, h)
        label(anomalyMeta(activeId).name, x, y, col)
        continue
      }
      if (!drawObjects || near) continue
      if (isSel) {
        ctx.fillStyle = 'rgba(75,79,224,0.16)'
        ctx.fillRect(x, y, w, h)
        ctx.lineWidth = 2.5 * s
        ctx.strokeStyle = '#7C80FF'
        ctx.setLineDash([])
        ctx.strokeRect(x, y, w, h)
        label(displayName(v), x, y, '#4B4FE0')
      } else {
        ctx.setLineDash([])
        ctx.lineWidth = (isHover ? 4 : 3) * s
        ctx.strokeStyle = 'rgba(8,12,20,0.35)'
        ctx.strokeRect(x, y, w, h)
        ctx.lineWidth = (isHover ? 2 : 1.25) * s
        ctx.strokeStyle = isHover ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.8)'
        ctx.setLineDash(isHover ? [] : [5 * s, 4 * s])
        ctx.strokeRect(x, y, w, h)
        if (isHover) label(displayName(v), x, y, 'rgba(12,18,30,0.82)')
      }
    }
    ctx.setLineDash([])
  }, [snapshot, frame, selected, hover, drawObjects, bw, bh, dpr])

  const norm = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height }
  }
  const onMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!snapshot || !drawObjects) return
    const { nx, ny } = norm(e)
    const name = pickActorAt(snapshot.visible, nx, ny)
    if (name !== hover) setHover(name)
  }
  const onClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!snapshot || !targeting) return
    const { nx, ny } = norm(e)
    const name = pickActorAt(snapshot.visible, nx, ny)
    if (name) selectActor(name === selected ? null : name)
  }

  const connected = conn === 'connected'
  const recording = !!snapshot?.capture.running
  const waitingFocus = recording && (snapshot?.capture.framesWritten ?? 0) === 0

  return (
    <div className="live">
      <div className="live-stage" ref={wrap} style={{ aspectRatio: String(aspect) }}>
        {connected ? (
          <div className="live-frame" style={{ width: box.w, height: box.h }}>
            <canvas ref={frameCanvas} className="live-canvas" style={{ width: box.w, height: box.h }} />
            <canvas
              ref={overlayCanvas}
              className={`live-canvas live-overlay${targeting ? ' is-picking' : ''}${hover && targeting ? ' is-hovering' : ''}`}
              style={{ width: box.w, height: box.h }}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
              onClick={onClick}
            />
            {recording && (
              <div className="live-paused">
                <CirclePause size={28} strokeWidth={1.6} />
                <div className="live-paused-title">{waitingFocus ? 'Click into the game window to begin' : 'Live view paused while recording'}</div>
                <div className="live-paused-sub">
                  {waitingFocus
                    ? 'Capture starts the moment the game window has focus.'
                    : 'This keeps the capture smooth. The view comes back when the run ends.'}
                </div>
              </div>
            )}
            {!recording && !frame && nowTick - connectedAt <= 3000 && (
              <div className="live-paused">
                <div className="live-paused-title">Waiting for the picture…</div>
              </div>
            )}
            {!recording && (frame ? nowTick - lastFrameAt > 4000 : nowTick - connectedAt > 3000) && (
              <div className="live-paused">
                <div className="live-paused-title">{frame ? 'The picture has paused' : 'No picture from the game yet'}</div>
                <div className="live-paused-sub">
                  If the game window is minimized, restore it. A minimized game stops sending its picture.
                </div>
              </div>
            )}
          </div>
        ) : (
          <ConnectHelp />
        )}
      </div>
      {connected && !recording && (
        <div className="live-bar">
          {targeting ? (
            <span className="live-hint">
              Click an object in the view to pick it as the target.
            </span>
          ) : (
            <span className="live-hint">Coloured boxes show anomalies as they happen.</span>
          )}
          <span className="grow" />
          {!targeting && (
            <button className="link-btn" onClick={() => setShowObjects((v) => !v)}>
              {showObjects ? <EyeOff size={15} /> : <Eye size={15} />}
              {showObjects ? 'Hide objects' : 'Show objects'}
            </button>
          )}
          <span className="live-meta">
            {snapshot ? `${snapshot.visible.length} objects in view` : ''}
            {snapshot?.session ? ` · ${Math.round(snapshot.session.fps)} fps` : ''}
          </span>
        </div>
      )}
    </div>
  )
}
