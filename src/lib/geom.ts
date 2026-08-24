import type { VisibleActor } from '../types'

export const NEAR_FULLSCREEN_AREA = 0.8

export function rectArea(r: number[]): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
}

export function rectContains(r: number[], nx: number, ny: number): boolean {
  return nx >= r[0] && nx <= r[2] && ny >= r[1] && ny <= r[3]
}

export function isNearFullscreen(r: number[]): boolean {
  return rectArea(r) >= NEAR_FULLSCREEN_AREA
}

function outranks(a: VisibleActor, b: VisibleActor): boolean {
  const aNear = isNearFullscreen(a.rect)
  const bNear = isNearFullscreen(b.rect)
  if (aNear !== bNear) return !aNear
  if (a.dist !== b.dist) return a.dist < b.dist
  return rectArea(a.rect) < rectArea(b.rect)
}

export function pickActorAt(visible: VisibleActor[], nx: number, ny: number): string | null {
  let best: VisibleActor | null = null
  for (const v of visible) {
    if (!v.rectValid) continue
    if (!rectContains(v.rect, nx, ny)) continue
    if (!best || outranks(v, best)) best = v
  }
  return best ? best.name : null
}
