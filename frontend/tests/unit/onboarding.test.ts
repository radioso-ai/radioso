import { afterEach, describe, expect, it, vi } from 'vitest'

import { shouldAutoActivateOnboarding } from '@/lib/onboarding'

const createLocalStorage = (seed: Record<string, string> = {}) => {
  const store = new Map(Object.entries(seed))

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

describe('shouldAutoActivateOnboarding', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('activates onboarding for an empty workspace when no onboarding has completed for that workspace', () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage(),
    })

    expect(
      shouldAutoActivateOnboarding({
        workspaceId: 'workspace-1',
        workspaceCount: 1,
        documentCount: 0,
        conversationCount: 0,
      })
    ).toBe(true)
  })

  it('activates onboarding for later empty workspaces too', () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage(),
    })

    expect(
      shouldAutoActivateOnboarding({
        workspaceId: 'workspace-2',
        workspaceCount: 2,
        documentCount: 0,
        conversationCount: 0,
      })
    ).toBe(true)
  })

  it('activates onboarding even if another workspace completed the guided flow', () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.onboardingCompleted': JSON.stringify({ 'workspace-1': true }),
      }),
    })

    expect(
      shouldAutoActivateOnboarding({
        workspaceId: 'workspace-2',
        workspaceCount: 1,
        documentCount: 0,
        conversationCount: 0,
      })
    ).toBe(true)
  })

  it('does not activate onboarding after this workspace completed the guided flow', () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage({
        'radioso.onboardingCompleted': JSON.stringify({ 'workspace-2': true }),
      }),
    })

    expect(
      shouldAutoActivateOnboarding({
        workspaceId: 'workspace-2',
        workspaceCount: 1,
        documentCount: 0,
        conversationCount: 0,
      })
    ).toBe(false)
  })
})
