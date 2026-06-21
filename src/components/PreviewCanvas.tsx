import { useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useStore } from '../store'
import { isNearFullscreen, pickActorAt, rectArea } from '../lib/geom'

const CW = 960
const CH = 540

export function PreviewCanvas() {
  const frame = useStore((s) => s.frame)
  const snapshot = useStore((s) => s.snapshot)
  const selected = useStore((s) => s.selectedActor)
  const overlay = useStore((s) => s.overlay)
  const toggleOverlay = useStore((s) => s.toggleOverlay)
  const selectActor = useStore((s) => s.selectActor)
  const frameCanvas = useRef<HTMLCanvasElement>(null)
  const overlayCanvas = useRef<HTMLCanvasElement>(null)

  // Draw the JPEG frame (stretched to the fixed canvas; overlay rects are normalized so this is consistent).
  useEffect(() => {
    const c = frameCanvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    if (frame?.bitmap) ctx.drawImage(frame.bitmap, 0, 0, c.width, c.height)
    else { ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, c.width, c.height) }
  }, [frame])

  // Draw the overlay (boxes / labels / active markers) from the snapshot.
  useEffect(() => {
    const c = overlayCanvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    if (!snapshot) return
    // Resolution change => epoch mismatch => skip overlay for this frame (best-effort alignment).
    if (frame && frame.epoch !== snapshot.epoch) return

    const activeTargets = new Set(snapshot.active.map((a) => a.target).filter(Boolean))

    for (const v of snapshot.visible) {
      if (!v.rectValid) continue
      const [x0, y0, x1, y1] = v.rect
      const x = x0 * c.width, y = y0 * c.height, w = (x1 - x0) * c.width, h = (y1 - y0) * c.height
      const near = isNearFullscreen(v.rect)
      const isSel = v.name === selected
      const isActive = activeTargets.has(v.name)

      if (overlay.boxes) {
        ctx.lineWidth = isSel ? 2.5 : 1
        ctx.strokeStyle = isSel ? '#ecc94b' : near ? 'rgba(120,130,140,0.22)' : 'rgba(99,179,237,0.8)'
        ctx.strokeRect(x, y, w, h)
      }
      if (overlay.active && isActive) {
        ctx.lineWidth = 2.5
        ctx.strokeStyle = '#f56565'
        ctx.strokeRect(x, y, w, h)
      }
      if (overlay.labels && !near && (isSel || isActive || rectArea(v.rect) < 0.15)) {
        ctx.font = '11px ui-monospace, monospace'
        const label = v.name
        const tw = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(5,7,10,0.7)'
        ctx.fillRect(x, Math.max(0, y - 13), tw + 6, 13)
        ctx.fillStyle = isSel ? '#ecc94b' : isActive ? '#fc8181' : 'rgba(200,215,230,0.95)'
        ctx.fillText(label, x + 3, Math.max(10, y - 3))
      }
    }
  }, [snapshot, frame, selected, overlay])

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
      <div className="canvas-wrap">
        <canvas ref={frameCanvas} width={CW} height={CH} className="frame-canvas" />
        <canvas ref={overlayCanvas} width={CW} height={CH} className="overlay-canvas" onClick={onClick} />
      </div>
    </div>
  )
}
