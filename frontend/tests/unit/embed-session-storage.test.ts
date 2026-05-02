import { afterEach, describe, expect, it } from 'vitest'

import {
  readStoredEmbedBootstrapSession,
  readStoredPublicSessionToken,
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
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toEqual({
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: expect.any(String),
    })
    expect(readStoredPublicSessionToken('public-token')).toBe('grant-token')

    expect(readStoredEmbedBootstrapSession('other-embed-token')).toBeNull()
  })

  it('drops expired embed bootstrap sessions', () => {
    // @ts-expect-error test-only window stub
    global.window = { sessionStorage: createSessionStorage() }

    storeEmbedBootstrapSession('embed-token', {
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toBeNull()
    expect(readStoredPublicSessionToken('public-token')).toBeNull()
  })
})
