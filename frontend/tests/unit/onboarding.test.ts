import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasOnboardingAnalyticsMarker,
  markOnboardingAnalyticsMarker,
} from '@/lib/onboarding-storage'
import { getOnboardingProgress } from '@/lib/onboarding'

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

describe('getOnboardingProgress', () => {
  it('counts the completed chat as the third first-run step', () => {
    expect(getOnboardingProgress({
      hasDocuments: true,
      hasReadyDocuments: true,
      hasCompletedChat: true,
    })).toBe(3)
  })
})

describe('onboarding analytics markers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps emitted funnel markers scoped to their workspace', () => {
    vi.stubGlobal('window', {
      localStorage: createLocalStorage(),
    })

    markOnboardingAnalyticsMarker('workspace-1', 'documents_added')

    expect(hasOnboardingAnalyticsMarker('workspace-1', 'documents_added')).toBe(true)
    expect(hasOnboardingAnalyticsMarker('workspace-2', 'documents_added')).toBe(false)
  })
})
