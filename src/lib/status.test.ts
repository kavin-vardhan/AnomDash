import { describe, it, expect } from 'vitest'
import { consoleStatus } from './status'
import type { ConnState } from '../types'

const OFFLINE_STATES: ConnState[] = ['disconnected', 'connecting', 'authenticating', 'auth_failed']

describe('consoleStatus', () => {
  it('LIVE when connected, not stalled, not capturing', () => {
    expect(consoleStatus({ conn: 'connected', stalled: false, capturing: false }))
      .toEqual({ key: 'live', word: 'LIVE', pulses: false })
  })

  it('CAPTURING when connected and capturing', () => {
    expect(consoleStatus({ conn: 'connected', stalled: false, capturing: true }))
      .toMatchObject({ key: 'capturing', word: 'CAPTURING' })
  })

  it('STALLED when connected and stalled', () => {
    expect(consoleStatus({ conn: 'connected', stalled: true, capturing: false }))
      .toMatchObject({ key: 'stalled', word: 'STALLED' })
  })

  it('STALLED BEATS CAPTURING (a stalled capture must read amber)', () => {
    expect(consoleStatus({ conn: 'connected', stalled: true, capturing: true }))
      .toMatchObject({ key: 'stalled', word: 'STALLED' })
  })

  it.each(OFFLINE_STATES)('OFFLINE for conn=%s', (conn) => {
    expect(consoleStatus({ conn, stalled: false, capturing: false }))
      .toMatchObject({ key: 'offline', word: 'OFFLINE' })
  })

  it('OFFLINE wins over stalled and capturing when not connected', () => {
    expect(consoleStatus({ conn: 'auth_failed', stalled: true, capturing: true }))
      .toMatchObject({ key: 'offline', word: 'OFFLINE' })
    expect(consoleStatus({ conn: 'disconnected', stalled: true, capturing: true }))
      .toMatchObject({ key: 'offline', word: 'OFFLINE' })
  })

  it('capturing is ignored unless connected', () => {
    expect(consoleStatus({ conn: 'connecting', stalled: false, capturing: true }).key).toBe('offline')
  })

  it('pulses on the states that demand attention, not on LIVE', () => {
    expect(consoleStatus({ conn: 'connected', stalled: false, capturing: false }).pulses).toBe(false)
    expect(consoleStatus({ conn: 'connected', stalled: true, capturing: false }).pulses).toBe(true)
    expect(consoleStatus({ conn: 'connected', stalled: false, capturing: true }).pulses).toBe(true)
  })
})
