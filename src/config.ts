export const BAKED_TOKEN = (import.meta.env.VITE_CONTROL_TOKEN ?? '').trim()

export const BAKED_CAPTURES_ROOT = (import.meta.env.VITE_CAPTURES_ROOT ?? '').trim()

export const DEFAULT_WS_URL = 'ws://127.0.0.1:8077'

export const TOKEN_STORAGE_KEY = 'iai_token'
export const WSURL_STORAGE_KEY = 'iai_wsurl'

export function loadStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function storeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}
