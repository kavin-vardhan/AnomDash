import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useStore } from '../store'
import { isNearFullscreen, pickActorAt, rectArea } from '../lib/geom'

const FALLBACK_W = 960
const FALLBACK_H = 540

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function fit(c: HTMLCanvasElement, w: number, h: number) {
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
}

export function PreviewCanvas() {
  const frame = useStore((s) => s.frame)
  const snapshot = useStore((s) => s.snapshot)
  const selected = useStore((s) => s.selectedActor)
  const overlay = useStore((s) => s.overlay)
  const toggleOverlay = useStore((s) => s.toggleOverlay)
  const selectActor = useStore((s) => s.selectActor)
  const wrap = useRef<HTMLDivElement>(null)
  const frameCanvas = useRef<HTMLCanvasElement>(null)
  const overlayCanvas = useRef<HTMLCanvasElement>(null)

  const [cssSize, setCssSize] = useState({ w: FALLBACK_W, h: FALLBACK_H })
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return
      setCssSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }))
    }
    measure()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    let mq: MediaQueryList | null = null
    let stopped = false
    const onChange = () => {
      if (stopped) return
      setDpr(window.devicePixelRatio || 1)
      detach()
      arm()
    }
    const detach = () => {
      if (!mq) return
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else mq.removeListener(onChange)
      mq = null
    }
    const arm = () => {
      if (stopped) return
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      if (mq.addEventListener) mq.addEventListener('change', onChange)
      else mq.addListener(onChange)
    }
    arm()
    return () => { stopped = true; detach() }
  }, [])

  const bw = Math.max(1, Math.round(cssSize.w * dpr))
  const bh = Math.max(1, Math.round(cssSize.h * dpr))
  const scale = cssSize.w > 0 ? bw / cssSize.w : 1

  useEffect(() => {
    const c = frameCanvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    fit(c, bw, bh)
    if (frame?.bitmap) {
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(frame.bitmap, 0, 0, c.width, c.height)
    } else {
      ctx.fillStyle = token('--void', '#0A0D14')
      ctx.fillRect(0, 0, c.width, c.height)
    }
  }, [frame, bw, bh])

  useEffect(() => {
    const c = overlayCanvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    fit(c, bw, bh)
    ctx.clearRect(0, 0, c.width, c.height)
    if (!snapshot) return
    if (frame && frame.epoch !== snapshot.epoch) return

    const iris = token('--iris', '#828CF8')
    const irisLight = token('--iris-light', '#A5ADFF')
    const capturing = token('--capturing', '#45C4E9')
    const activeTargets = new Set(snapshot.active.map((a) => a.target).filter(Boolean))

    for (const v of snapshot.visible) {
      if (!v.rectValid) continue
      const [x0, y0, x1, y1] = v.rect
      const x = x0 * c.width, y = y0 * c.height, w = (x1 - x0) * c.width, h = (y1 - y0) * c.height
      const near = isNearFullscreen(v.rect)
      const isSel = v.name === selected
      const isActive = activeTargets.has(v.name)

      if (overlay.boxes) {
        ctx.lineWidth = (isSel ? 2.5 : 1) * scale
        ctx.strokeStyle = isSel ? iris : near ? 'rgba(140,165,200,0.22)' : 'rgba(140,165,200,0.5)'
        ctx.strokeRect(x, y, w, h)
      }
      if (overlay.active && isActive) {
        ctx.lineWidth = 2.5 * scale
        ctx.strokeStyle = capturing
        ctx.strokeRect(x, y, w, h)
      }
      if (overlay.labels && !near && (isSel || isActive || rectArea(v.rect) < 0.15)) {
        const fs = 11 * scale
        ctx.font = `${fs}px 'IBM Plex Mono', ui-monospace, monospace`
        const label = v.name
        const tw = ctx.measureText(label).width
        const boxH = 13 * scale
        ctx.fillStyle = 'rgba(10,13,20,0.7)'
        ctx.fillRect(x, Math.max(0, y - boxH), tw + 6 * scale, boxH)
        ctx.fillStyle = isSel ? irisLight : isActive ? capturing : 'rgba(200,215,230,0.9)'
        ctx.fillText(label, x + 3 * scale, Math.max(fs, y - 3 * scale))
      }
    }
  }, [snapshot, frame, selected, overlay, bw, bh, scale])

  const onClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    const c = overlayCanvas.current
    if (!c || !snapshot) return
    const r = c.getBoundingClientRect()
    const nx = (e.clientX - r.left) / r.width
    const ny = (e.clientY - r.top) / r.height
    selectActor(pickActorAt(snapshot.visible, nx, ny))
  }

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <label className="inline"><input type="checkbox" checked={overlay.boxes} onChange={() => toggleOverlay('boxes')} />boxes</label>
        <label className="inline"><input type="checkbox" checked={overlay.labels} onChange={() => toggleOverlay('labels')} />labels</label>
        <label className="inline"><input type="checkbox" checked={overlay.active} onChange={() => toggleOverlay('active')} />active</label>
        <span className="grow" />
        <span className="dim">
          {frame ? `${frame.w}×${frame.h} #${frame.frameId}` : 'no frame'} · visible {snapshot?.visible.length ?? 0}
          {selected ? ` · sel ${selected}` : ''}
        </span>
      </div>
      <div className="canvas-wrap" ref={wrap}>
        <canvas ref={frameCanvas} className="frame-canvas" />
        <canvas ref={overlayCanvas} className="overlay-canvas" onClick={onClick} />
      </div>
    </div>
  )
}
