export interface RuntimeConfig {
  controlToken: string
  capturesRoot: string
  serverUrl: string
}

export const DEFAULT_WS_URL = 'ws://127.0.0.1:8077'
export const CONFIG_URL = './config.json'

export const TOKEN_STORAGE_KEY = 'iai_token'
export const WSURL_STORAGE_KEY = 'iai_wsurl'

const DEFAULTS: RuntimeConfig = {
  controlToken: '',
  capturesRoot: '',
  serverUrl: DEFAULT_WS_URL,
}

let current: RuntimeConfig = { ...DEFAULTS }

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function isConfigObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (!isConfigObject(raw)) return { ...DEFAULTS }
  return {
    controlToken: asString(raw.controlToken),
    capturesRoot: asString(raw.capturesRoot),
    serverUrl: asString(raw.serverUrl) || DEFAULT_WS_URL,
  }
}

const ABSENT = 'starting on the manual connect screen'

function stripBom(text: string): string {
  return text.replace(/^﻿/, '')
}

function applyConfigText(text: string): RuntimeConfig {
  let raw: unknown
  try {
    raw = JSON.parse(stripBom(text))
  } catch (err) {
    console.warn(`config.json is not valid JSON (${String(err)}) — ignoring it; ${ABSENT}`)
    return current
  }
  if (!isConfigObject(raw)) {
    console.warn(`config.json is not a JSON object — ignoring it; ${ABSENT}`)
    return current
  }
  current = parseRuntimeConfig(raw)
  return current
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function loadViaTauri(): Promise<RuntimeConfig> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const text = await invoke<string>('read_config')
    return applyConfigText(text)
  } catch (err) {
    console.info(`config.json not found next to the app (${String(err)}) — ${ABSENT}`)
    return current
  }
}

async function loadViaFetch(): Promise<RuntimeConfig> {
  try {
    const res = await fetch(CONFIG_URL, { cache: 'no-store' })
    if (!res.ok) {
      console.info(`config.json not found (HTTP ${res.status}) — ${ABSENT}`)
      return current
    }
    const text = stripBom(await res.text())
    if (text.trim().startsWith('<')) {
      console.info(`config.json not found (the server returned a page instead) — ${ABSENT}`)
      return current
    }
    return applyConfigText(text)
  } catch (err) {
    console.warn(`config.json could not be read (${String(err)}) — ignoring it; ${ABSENT}`)
    current = { ...DEFAULTS }
    return current
  }
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  current = { ...DEFAULTS }
  return inTauri() ? loadViaTauri() : loadViaFetch()
}

export function controlToken(): string {
  return current.controlToken
}

export function capturesRoot(): string {
  return current.capturesRoot
}

export function serverUrl(): string {
  return current.serverUrl
}

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
