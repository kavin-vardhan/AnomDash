import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  loadRuntimeConfig, parseRuntimeConfig, controlToken, capturesRoot, serverUrl,
  DEFAULT_WS_URL, CONFIG_URL,
} from './config'

function okResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

function okRaw(text: string) {
  return { ok: true, status: 200, text: async () => text }
}

function notFound() {
  return { ok: false, status: 404, text: async () => '' }
}

function stubFetch(impl: () => unknown) {
  const fn = vi.fn(async () => impl() as Response)
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseRuntimeConfig (pure)', () => {
  it('reads all three fields and trims them', () => {
    expect(parseRuntimeConfig({ controlToken: '  TOK  ', capturesRoot: ' D:/Caps ', serverUrl: ' ws://x:1 ' }))
      .toEqual({ controlToken: 'TOK', capturesRoot: 'D:/Caps', serverUrl: 'ws://x:1' })
  })

  it('defaults serverUrl when absent or blank', () => {
    expect(parseRuntimeConfig({ controlToken: 'T' }).serverUrl).toBe(DEFAULT_WS_URL)
    expect(parseRuntimeConfig({ controlToken: 'T', serverUrl: '   ' }).serverUrl).toBe(DEFAULT_WS_URL)
  })

  it('ignores non-string field types rather than throwing', () => {
    expect(parseRuntimeConfig({ controlToken: 42, capturesRoot: null, serverUrl: [] }))
      .toEqual({ controlToken: '', capturesRoot: '', serverUrl: DEFAULT_WS_URL })
  })

  it('returns defaults for non-objects', () => {
    for (const raw of [null, undefined, 'string', 7, ['a']]) {
      expect(parseRuntimeConfig(raw)).toEqual({ controlToken: '', capturesRoot: '', serverUrl: DEFAULT_WS_URL })
    }
  })
})

describe('loadRuntimeConfig', () => {
  it('fetches ./config.json with no-store and applies it', async () => {
    const fn = stubFetch(() => okResponse({ controlToken: 'TOK', capturesRoot: 'D:/Caps', serverUrl: 'ws://h:9' }))
    const cfg = await loadRuntimeConfig()
    expect(fn).toHaveBeenCalledWith(CONFIG_URL, { cache: 'no-store' })
    expect(cfg.controlToken).toBe('TOK')
    expect(controlToken()).toBe('TOK')
    expect(capturesRoot()).toBe('D:/Caps')
    expect(serverUrl()).toBe('ws://h:9')
  })

  it('ABSENT (404): defaults, no throw, info not warn', async () => {
    stubFetch(notFound)
    await expect(loadRuntimeConfig()).resolves.toBeDefined()
    expect(controlToken()).toBe('')
    expect(serverUrl()).toBe(DEFAULT_WS_URL)
    expect(console.info).toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('MALFORMED json: defaults + warning, no throw', async () => {
    stubFetch(() => okRaw('{ "controlToken": "TOK", }'))
    await expect(loadRuntimeConfig()).resolves.toBeDefined()
    expect(controlToken()).toBe('')
    expect(serverUrl()).toBe(DEFAULT_WS_URL)
    expect(console.warn).toHaveBeenCalled()
  })

  it('SPA fallback (server returns index.html): treated as absent, info not warn', async () => {
    stubFetch(() => okRaw('<!doctype html>\n<html><body>app</body></html>'))
    await loadRuntimeConfig()
    expect(controlToken()).toBe('')
    expect(console.info).toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('valid JSON is accepted regardless of the served content-type', async () => {
    stubFetch(() => okRaw('{"controlToken":"TOK","capturesRoot":"D:/C"}'))
    await loadRuntimeConfig()
    expect(controlToken()).toBe('TOK')
    expect(capturesRoot()).toBe('D:/C')
  })

  it('NON-OBJECT body: defaults + warning', async () => {
    stubFetch(() => okResponse(['not', 'a', 'config']))
    await loadRuntimeConfig()
    expect(controlToken()).toBe('')
    expect(console.warn).toHaveBeenCalled()
  })

  it('network failure: defaults + warning, no throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(loadRuntimeConfig()).resolves.toBeDefined()
    expect(controlToken()).toBe('')
    expect(console.warn).toHaveBeenCalled()
  })

  it('TOKENLESS config: other fields apply, token stays empty (manual connect)', async () => {
    stubFetch(() => okResponse({ capturesRoot: 'E:/AnomalyCaptures' }))
    await loadRuntimeConfig()
    expect(controlToken()).toBe('')
    expect(capturesRoot()).toBe('E:/AnomalyCaptures')
  })

  it('a later load fully replaces earlier values', async () => {
    stubFetch(() => okResponse({ controlToken: 'FIRST', capturesRoot: 'A' }))
    await loadRuntimeConfig()
    expect(controlToken()).toBe('FIRST')
    stubFetch(notFound)
    await loadRuntimeConfig()
    expect(controlToken()).toBe('')
    expect(capturesRoot()).toBe('')
  })
})
