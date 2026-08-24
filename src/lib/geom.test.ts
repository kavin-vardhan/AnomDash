import { describe, it, expect } from 'vitest'
import { pickActorAt, rectArea } from './geom'
import type { VisibleActor } from '../types'

function actor(name: string, rect: number[], dist: number): VisibleActor {
  return { name, class: 'StaticMeshActor', comp: 'static', dist, rect, rectValid: true }
}

const FRONT = actor('StaticMeshActor_66', [0.20, 0.20, 0.80, 0.80], 500)
const BEHIND = actor('StaticMeshActor_80', [0.45, 0.45, 0.55, 0.55], 3000)

describe('pickActorAt', () => {
  it('picks the nearer FRONT object over a smaller one further away', () => {
    expect(rectArea(FRONT.rect)).toBeCloseTo(0.36)
    expect(rectArea(BEHIND.rect)).toBeCloseTo(0.01)
    expect(pickActorAt([FRONT, BEHIND], 0.5, 0.5)).toBe('StaticMeshActor_66')
  })

  it('is independent of declaration order', () => {
    expect(pickActorAt([BEHIND, FRONT], 0.5, 0.5)).toBe('StaticMeshActor_66')
  })

  it('ranks by distance, not by area', () => {
    const near = actor('NEAR_big', [0.20, 0.20, 0.80, 0.80], 100)
    const far = actor('FAR_small', [0.45, 0.45, 0.55, 0.55], 9999)
    expect(pickActorAt([near, far], 0.5, 0.5)).toBe('NEAR_big')
  })

  it('picks the front object where the small one does not overlap', () => {
    expect(pickActorAt([FRONT, BEHIND], 0.25, 0.25)).toBe('StaticMeshActor_66')
  })

  it('deprioritises a near-fullscreen candidate when another contains the point', () => {
    const huge = actor('StaticMeshActor_66', [0.0, 0.0, 1.0, 1.0], 500)
    expect(pickActorAt([huge, BEHIND], 0.5, 0.5)).toBe('StaticMeshActor_80')
  })

  it('selects a near-fullscreen candidate when it is the only one', () => {
    const huge = actor('StaticMeshActor_66', [0.0, 0.0, 1.0, 1.0], 500)
    expect(pickActorAt([huge], 0.5, 0.5)).toBe('StaticMeshActor_66')
  })

  it('picks the nearest of three stacked actors', () => {
    const mid = actor('StaticMeshActor_72', [0.35, 0.35, 0.65, 0.65], 1200)
    expect(pickActorAt([FRONT, mid, BEHIND], 0.5, 0.5)).toBe('StaticMeshActor_66')
  })

  it('breaks a distance tie by the smaller area', () => {
    const big = actor('BIG', [0.20, 0.20, 0.80, 0.80], 500)
    const small = actor('SMALL', [0.45, 0.45, 0.55, 0.55], 500)
    expect(pickActorAt([big, small], 0.5, 0.5)).toBe('SMALL')
    expect(pickActorAt([small, big], 0.5, 0.5)).toBe('SMALL')
  })

  it('returns null when nothing contains the point', () => {
    expect(pickActorAt([FRONT, BEHIND], 0.02, 0.02)).toBe(null)
  })

  it('ignores candidates with an invalid rect', () => {
    const bad = { ...BEHIND, rectValid: false }
    expect(pickActorAt([bad], 0.5, 0.5)).toBe(null)
  })
})
