import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  activateWorkspaceSession,
  clearWorkspaceStorage,
  getStoredActiveWorkspaceId,
  getStoredActiveWorkspacePublicRouteKey,
  removeWorkspaceSession,
  seedWorkspaceSession,
} from '@/lib/api'

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
  }
}

const createInterleavingLocalStorage = () => {
  const store = new Map<string, string>()
  let onFirstSet: (() => void) | null = null
  let hasInterleaved = false

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
      if (!hasInterleaved && onFirstSet) {
        hasInterleaved = true
        onFirstSet()
      }
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    interleaveOnNextSet: (callback: () => void) => {
      onFirstSet = callback
    },
  }
}

describe('workspace session bootstrap', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('seeds and switches the active workspace without storing bearer tokens', () => {
    const localStorage = createLocalStorage()
    vi.stubGlobal('window', { localStorage })

    seedWorkspaceSession('workspace-a')
    expect(getStoredActiveWorkspaceId()).toBe('workspace-a')
    expect(JSON.parse(localStorage.getItem('radioso.activeWorkspaceSelection') ?? 'null')).toEqual({
      workspaceId: 'workspace-a',
      workspacePublicRouteKey: null,
    })
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()

    activateWorkspaceSession('workspace-b')
    expect(getStoredActiveWorkspaceId()).toBe('workspace-b')
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
  })

  it('removes the active workspace id and clears cached workspace tokens', () => {
    const localStorage = createLocalStorage({
      'radioso.apiToken': 'radioso_legacy',
      'radioso.activeWorkspaceId': 'workspace-a',
    })
    vi.stubGlobal('window', { localStorage })

    removeWorkspaceSession('workspace-a')
    expect(getStoredActiveWorkspaceId()).toBeNull()
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()

    clearWorkspaceStorage()
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
  })

  it('removes a matching serialized default and the current tab selection', () => {
    const localStorage = createLocalStorage()
    const sessionStorage = createLocalStorage()
    vi.stubGlobal('window', { localStorage, sessionStorage })
    seedWorkspaceSession('workspace-a', 'route-a')

    removeWorkspaceSession('workspace-a')

    expect(localStorage.getItem('radioso.activeWorkspaceSelection')).toBeNull()
    expect(sessionStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
    expect(sessionStorage.getItem('radioso.activeWorkspacePublicRouteKey')).toBeNull()
  })

  it('keeps workspace selection and route keys isolated between tabs', () => {
    const localStorage = createLocalStorage()
    const firstTab = { localStorage, sessionStorage: createLocalStorage() }
    const secondTab = { localStorage, sessionStorage: createLocalStorage() }
    vi.stubGlobal('window', firstTab)
    seedWorkspaceSession('workspace-a', 'route-a')

    vi.stubGlobal('window', secondTab)
    activateWorkspaceSession('workspace-b', 'route-b')

    vi.stubGlobal('window', firstTab)
    expect(getStoredActiveWorkspaceId()).toBe('workspace-a')
    expect(getStoredActiveWorkspacePublicRouteKey()).toBe('route-a')
    removeWorkspaceSession('workspace-a')
    expect(JSON.parse(localStorage.getItem('radioso.activeWorkspaceSelection') ?? 'null')).toEqual({
      workspaceId: 'workspace-b',
      workspacePublicRouteKey: 'route-b',
    })

    vi.stubGlobal('window', secondTab)
    expect(getStoredActiveWorkspaceId()).toBe('workspace-b')
    expect(getStoredActiveWorkspacePublicRouteKey()).toBe('route-b')
  })

  it('migrates a legacy remembered workspace selection before pinning it to a new tab', () => {
    const localStorage = createLocalStorage({
      'radioso.activeWorkspaceId': 'workspace-a',
      'radioso.activeWorkspacePublicRouteKey': 'route-a',
    })
    const sessionStorage = createLocalStorage()
    vi.stubGlobal('window', { localStorage, sessionStorage })
    expect(getStoredActiveWorkspacePublicRouteKey()).toBe('route-a')
    expect(JSON.parse(localStorage.getItem('radioso.activeWorkspaceSelection') ?? 'null')).toEqual({
      workspaceId: 'workspace-a',
      workspacePublicRouteKey: 'route-a',
    })
    localStorage.setItem('radioso.activeWorkspaceId', 'workspace-b')
    localStorage.setItem('radioso.activeWorkspacePublicRouteKey', 'route-b')
    expect(getStoredActiveWorkspaceId()).toBe('workspace-a')

    activateWorkspaceSession('workspace-c')
    expect(getStoredActiveWorkspacePublicRouteKey()).toBeNull()
    clearWorkspaceStorage()
    expect(getStoredActiveWorkspaceId()).toBeNull()
    expect(sessionStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
    expect(sessionStorage.getItem('radioso.activeWorkspacePublicRouteKey')).toBeNull()
    expect(localStorage.getItem('radioso.activeWorkspaceSelection')).toBeNull()
    expect(localStorage.getItem('radioso.activeWorkspacePublicRouteKey')).toBeNull()
  })

  it('does not pin a mixed remembered pair when shared-storage writes interleave', () => {
    const localStorage = createInterleavingLocalStorage()
    const firstTab = { localStorage, sessionStorage: createLocalStorage() }
    const secondTab = { localStorage, sessionStorage: createLocalStorage() }

    vi.stubGlobal('window', firstTab)
    localStorage.interleaveOnNextSet(() => {
      vi.stubGlobal('window', secondTab)
      activateWorkspaceSession('workspace-b', 'route-b')
      vi.stubGlobal('window', firstTab)
    })
    seedWorkspaceSession('workspace-a', 'route-a')

    const freshTab = { localStorage, sessionStorage: createLocalStorage() }
    vi.stubGlobal('window', freshTab)
    expect(getStoredActiveWorkspaceId()).toBe('workspace-b')
    expect(getStoredActiveWorkspacePublicRouteKey()).toBe('route-b')
  })
})
