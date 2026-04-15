import { afterEach, describe, expect, it } from 'vitest'

import {
  readStoredEmbedBootstrapSession,
  readStoredEmbedSessionToken,
  storeEmbedBootstrapSession,
} from '@/lib/api'

const createSessionStorage = () => {
  const store = new Map<string, string>()
  return {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
  }
}

afterEach(() => {
  // @ts-expect-error test cleanup
  delete global.window
})

describe('embed session storage helpers', () => {
  it('persists and restores a valid embed bootstrap session', () => {
    // @ts-expect-error test-only window stub
    global.window = { sessionStorage: createSessionStorage() }

    storeEmbedBootstrapSession('embed-token', {
      publicChatToken: 'public-token',
      embedSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toEqual({
      publicChatToken: 'public-token',
      embedSessionToken: 'grant-token',
      expiresAt: expect.any(String),
    })
    expect(readStoredEmbedSessionToken('public-token')).toBe('grant-token')

    expect(readStoredEmbedBootstrapSession('other-embed-token')).toBeNull()
  })

  it('drops expired embed bootstrap sessions', () => {
    // @ts-expect-error test-only window stub
    global.window = { sessionStorage: createSessionStorage() }

    storeEmbedBootstrapSession('embed-token', {
      publicChatToken: 'public-token',
      embedSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toBeNull()
    expect(readStoredEmbedSessionToken('public-token')).toBeNull()
  })
})
