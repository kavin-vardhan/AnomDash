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

export function pickActorAt(visible: VisibleActor[], nx: number, ny: number): string | null {
  let best: VisibleActor | null = null
  let bestArea = Infinity
  for (const v of visible) {
    if (!v.rectValid) continue
    const a = rectArea(v.rect)
    if (a >= NEAR_FULLSCREEN_AREA) continue
    if (rectContains(v.rect, nx, ny) && a < bestArea) {
      best = v
      bestArea = a
    }
  }
  return best ? best.name : null
}
