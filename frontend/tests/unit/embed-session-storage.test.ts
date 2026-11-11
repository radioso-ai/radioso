import { afterEach, describe, expect, it } from 'vitest'

import {
  clearStoredAnonymousSession,
  readStoredEmbedBootstrapSession,
  readStoredPublicSessionAcceptsImages,
  readStoredPublicSessionResumeToken,
  readStoredPublicSessionToken,
  storeEmbedBootstrapSession,
} from '@/lib/api'
import { storePublicSessionAcceptsImages } from '@/lib/api-client'

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

  it('remembers whether the agent takes photos for the length of the session', () => {
    // @ts-expect-error test-only window stub
    global.window = { sessionStorage: createSessionStorage() }
    const session = {
      publicChatToken: 'public-token',
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resumeToken: 'resume-token',
      resumeExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    }

    storeEmbedBootstrapSession('embed-token', { ...session, acceptsImages: true })
    expect(readStoredPublicSessionAcceptsImages('public-token')).toBe(true)
    expect(readStoredPublicSessionAcceptsImages('another-token')).toBe(false)

    storeEmbedBootstrapSession('embed-token', session)
    expect(readStoredPublicSessionAcceptsImages('public-token')).toBe(false)

    storePublicSessionAcceptsImages('public-token', true)
    clearStoredAnonymousSession('public-token')
    expect(readStoredPublicSessionAcceptsImages('public-token')).toBe(false)
  })

  it('reads as not accepting photos where there is no browser storage', () => {
    expect(readStoredPublicSessionAcceptsImages('public-token')).toBe(false)
  })
})
