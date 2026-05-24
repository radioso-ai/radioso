import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildPublicChatSessionHandoffHash,
  consumePublicChatSessionHandoffHash,
  readPublicChatSessionHandoffHash,
} from '@/lib/public-chat-session-handoff'
import {
  readStoredAnonymousSessionId,
  readStoredPublicSessionToken,
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
  vi.restoreAllMocks()
})

describe('public chat session handoff', () => {
  it('round-trips the public session grant through a URL fragment', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const hash = buildPublicChatSessionHandoffHash({
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt,
    })

    expect(hash).toMatch(/^radiosoSession=/u)
    expect(readPublicChatSessionHandoffHash(`#${hash}`)).toEqual({
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt,
    })
  })

  it('stores a valid handoff and strips the consumed fragment', () => {
    const sessionStorage = createSessionStorage()
    const replaceState = vi.fn()
    global.window = {
      sessionStorage,
      location: {
        pathname: '/chat/public-token',
        search: '?locale=en',
        hash: '',
      },
      history: {
        state: null,
        replaceState,
      },
    } as unknown as Window & typeof globalThis

    const hash = buildPublicChatSessionHandoffHash({
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(consumePublicChatSessionHandoffHash('public-token', `#keep=1&${hash}`)).toBe(true)
    expect(readStoredAnonymousSessionId('public-token')).toBe('7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11')
    expect(readStoredPublicSessionToken('public-token')).toBe('grant-token')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/chat/public-token?locale=en#keep=1')
  })

  it('ignores expired handoffs', () => {
    const sessionStorage = createSessionStorage()
    global.window = {
      sessionStorage,
      location: {
        pathname: '/chat/public-token',
        search: '',
        hash: '',
      },
      history: {
        state: null,
        replaceState: vi.fn(),
      },
    } as unknown as Window & typeof globalThis

    const hash = buildPublicChatSessionHandoffHash({
      publicSessionId: '7e4c4c1a-5b6d-4a59-9b2c-fdd9f1debe11',
      publicSessionToken: 'grant-token',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    expect(consumePublicChatSessionHandoffHash('public-token', `#${hash}`)).toBe(false)
    expect(readStoredAnonymousSessionId('public-token')).toBeNull()
    expect(readStoredPublicSessionToken('public-token')).toBeNull()
  })
})
