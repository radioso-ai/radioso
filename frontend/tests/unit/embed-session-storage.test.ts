import { afterEach, describe, expect, it } from 'vitest'

import {
  clearStoredEmbedBootstrapSession,
  readStoredAnonymousSessionId,
  readStoredEmbedBootstrapSession,
  readStoredPublicSessionResumeToken,
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

/** A frame whose browser blocks storage: reading `sessionStorage` throws, as in a third-party iframe. */
const createStorageBlockedWindow = () => {
  const blocked = {}
  Object.defineProperty(blocked, 'sessionStorage', {
    get() {
      throw new DOMException("Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document.", 'SecurityError')
    },
  })
  return blocked
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
      resumeToken: 'resume-token',
      resumeExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toEqual({
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: expect.any(String),
      resumeToken: 'resume-token',
      resumeExpiresAt: expect.any(String),
    })
    expect(readStoredPublicSessionToken('public-token')).toBe('grant-token')
    expect(readStoredPublicSessionResumeToken('public-token')).toBe('resume-token')

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
      resumeToken: 'resume-token',
      resumeExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toBeNull()
    expect(readStoredPublicSessionToken('public-token')).toBeNull()
  })

  it('restores embed bootstrap sessions without action metadata', () => {
    // @ts-expect-error test-only window stub
    global.window = { sessionStorage: createSessionStorage() }

    storeEmbedBootstrapSession('embed-token', {
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resumeToken: 'resume-token',
      resumeExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toMatchObject({
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
    })
    expect(readStoredPublicSessionToken('public-token')).toBe('grant-token')
  })

  it('keeps the visitor session for the life of the frame when the browser blocks storage', () => {
    // @ts-expect-error test-only window stub
    global.window = createStorageBlockedWindow()

    storeEmbedBootstrapSession('embed-token', {
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resumeToken: 'resume-token',
      resumeExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    })

    expect(readStoredEmbedBootstrapSession('embed-token')).toMatchObject({
      publicChatToken: 'public-token',
      publicSessionToken: 'grant-token',
    })
    expect(readStoredPublicSessionToken('public-token')).toBe('grant-token')
    expect(readStoredPublicSessionResumeToken('public-token')).toBe('resume-token')
    expect(readStoredAnonymousSessionId('public-token')).toBe('7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11')

    clearStoredEmbedBootstrapSession('embed-token')

    expect(readStoredEmbedBootstrapSession('embed-token')).toBeNull()
    expect(readStoredPublicSessionToken('public-token')).toBeNull()
  })

  it.each<{ browser: string; createWindow: () => unknown }>([
    { browser: 'has no sessionStorage', createWindow: () => ({ sessionStorage: null }) },
    { browser: 'refuses writes to sessionStorage', createWindow: () => ({
      sessionStorage: {
        ...createSessionStorage(),
        setItem() {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        },
      },
    }) },
  ])('keeps the visitor session in memory when the browser $browser', ({ createWindow }) => {
    // @ts-expect-error test-only window stub
    global.window = createWindow()

    storeEmbedBootstrapSession('embed-token', {
      workspaceName: 'Support concierge',
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resumeToken: 'resume-token',
      resumeExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    })

    expect(readStoredPublicSessionToken('public-token')).toBe('grant-token')
    expect(readStoredAnonymousSessionId('public-token')).toBe('7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11')
  })
})
