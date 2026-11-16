import { describe, expect, it } from 'vitest'

import {
  CHUNK_RELOAD_GUARD_WINDOW_MS,
  CHUNK_RELOAD_PARAM,
  isChunkLoadFailure,
  planChunkLoadRecovery,
} from '@/lib/chunk-load-recovery'

const NOW = 1_800_000_000_000

const chunkLoadError = (message = 'Loading chunk 482 failed.'): Error => {
  const error = new Error(message)
  error.name = 'ChunkLoadError'
  return error
}

describe('isChunkLoadFailure', () => {
  it('recognises the error both bundlers throw when a chunk cannot load', () => {
    expect(isChunkLoadFailure(chunkLoadError())).toBe(true)
  })

  it('recognises a chunk failure by its name whatever the message says', () => {
    expect(isChunkLoadFailure(chunkLoadError('Chargement du bloc 482 impossible.'))).toBe(true)
    expect(isChunkLoadFailure(chunkLoadError(''))).toBe(true)
  })

  it('recognises a chunk failure that something wrapped as the cause', () => {
    const wrapped = new Error('render failed', { cause: chunkLoadError() })
    expect(isChunkLoadFailure(wrapped)).toBe(true)
  })

  it('recognises a plain object that carries the chunk failure name', () => {
    expect(isChunkLoadFailure({ name: 'ChunkLoadError', message: 'Loading chunk 9 failed.' })).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isChunkLoadFailure(new Error('Loading chunk 482 failed.'))).toBe(false)
    expect(isChunkLoadFailure(new TypeError('Failed to fetch'))).toBe(false)
    expect(isChunkLoadFailure('ChunkLoadError')).toBe(false)
    expect(isChunkLoadFailure(undefined)).toBe(false)
    expect(isChunkLoadFailure(null)).toBe(false)
    expect(isChunkLoadFailure(42)).toBe(false)
  })

  it('stops following a cause chain that loops back on itself', () => {
    const first: { name: string; cause?: unknown } = { name: 'Error' }
    const second: { name: string; cause?: unknown } = { name: 'Error', cause: first }
    first.cause = second
    expect(isChunkLoadFailure(first)).toBe(false)
  })
})

describe('planChunkLoadRecovery', () => {
  const plan = (overrides: { error?: unknown; href?: string; now?: number } = {}) => planChunkLoadRecovery({
    error: chunkLoadError(),
    href: 'https://app.example/embed-frame?locale=it&displayMode=floating',
    now: NOW,
    ...overrides,
  })

  it('reloads the frame once for a chunk failure, marking the reloaded address', () => {
    const result = plan()

    expect(result.kind).toBe('reload')
    if (result.kind !== 'reload') return
    const reloaded = new URL(result.url)
    expect(reloaded.origin).toBe('https://app.example')
    expect(reloaded.pathname).toBe('/embed-frame')
    expect(reloaded.searchParams.get('locale')).toBe('it')
    expect(reloaded.searchParams.get('displayMode')).toBe('floating')
    expect(reloaded.searchParams.get(CHUNK_RELOAD_PARAM)).toBe(String(NOW))
  })

  it('keeps the rest of the address byte for byte, including the hash', () => {
    const result = plan({ href: 'https://app.example/w/acme/settings?copy=%7B%22a%22%3A%22b%20c%22%7D&x=a+b#section' })

    expect(result).toEqual({
      kind: 'reload',
      url: `https://app.example/w/acme/settings?copy=%7B%22a%22%3A%22b%20c%22%7D&x=a+b&${CHUNK_RELOAD_PARAM}=${NOW}#section`,
    })
  })

  it('marks an address that has no query yet', () => {
    expect(plan({ href: 'https://app.example/w/acme' })).toEqual({
      kind: 'reload',
      url: `https://app.example/w/acme?${CHUNK_RELOAD_PARAM}=${NOW}`,
    })
  })

  it('skips an error that is not a chunk failure', () => {
    expect(plan({ error: new Error('render failed') })).toEqual({ kind: 'skip', reason: 'not_chunk_failure' })
  })

  it('does not reload again when the address carries a fresh marker, because the reload did not fix it', () => {
    const href = `https://app.example/embed-frame?${CHUNK_RELOAD_PARAM}=${NOW - 5_000}`
    expect(plan({ href })).toEqual({ kind: 'skip', reason: 'reload_already_attempted' })
  })

  it('treats a marker from the future as fresh, so a skewed clock cannot start a loop', () => {
    const href = `https://app.example/embed-frame?${CHUNK_RELOAD_PARAM}=${NOW + 3_600_000}`
    expect(plan({ href })).toEqual({ kind: 'skip', reason: 'reload_already_attempted' })
  })

  it('reloads again once the marker is stale, replacing it rather than stacking a second one', () => {
    const stale = NOW - CHUNK_RELOAD_GUARD_WINDOW_MS
    const result = plan({ href: `https://app.example/embed-frame?locale=it&${CHUNK_RELOAD_PARAM}=${stale}` })

    expect(result).toEqual({
      kind: 'reload',
      url: `https://app.example/embed-frame?locale=it&${CHUNK_RELOAD_PARAM}=${NOW}`,
    })
  })

  it('treats a marker that is not a timestamp as stale', () => {
    const result = plan({ href: `https://app.example/embed-frame?${CHUNK_RELOAD_PARAM}=soon` })

    expect(result).toEqual({
      kind: 'reload',
      url: `https://app.example/embed-frame?${CHUNK_RELOAD_PARAM}=${NOW}`,
    })
  })

  it('skips an address it cannot mark', () => {
    expect(plan({ href: 'not a url' })).toEqual({ kind: 'skip', reason: 'unusable_url' })
    expect(plan({ href: 'about:srcdoc' })).toEqual({ kind: 'skip', reason: 'unusable_url' })
  })
})
