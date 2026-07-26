import type { ConnState } from '../types'

export type StatusKey = 'live' | 'stalled' | 'offline' | 'capturing'

export interface ConsoleStatus {
  key: StatusKey
  word: string
  pulses: boolean
}

export interface StatusInput {
  conn: ConnState
  stalled: boolean
  capturing: boolean
}

export function consoleStatus({ conn, stalled, capturing }: StatusInput): ConsoleStatus {
  if (conn !== 'connected') return { key: 'offline', word: 'OFFLINE', pulses: false }
  if (stalled) return { key: 'stalled', word: 'STALLED', pulses: true }
  if (capturing) return { key: 'capturing', word: 'CAPTURING', pulses: true }
  return { key: 'live', word: 'LIVE', pulses: false }
}
