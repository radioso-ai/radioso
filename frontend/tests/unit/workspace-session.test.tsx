import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  activateWorkspaceToken,
  clearWorkspaceStorage,
  getStoredActiveWorkspaceId,
  removeWorkspaceToken,
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

describe('workspace session bootstrap', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('seeds and switches the active workspace without storing bearer tokens', () => {
    const localStorage = createLocalStorage()
    vi.stubGlobal('window', { localStorage })

    seedWorkspaceSession('workspace-a')
    expect(getStoredActiveWorkspaceId()).toBe('workspace-a')
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.workspaceTokens')).toBeNull()

    activateWorkspaceToken('workspace-b')
    expect(getStoredActiveWorkspaceId()).toBe('workspace-b')
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.workspaceTokens')).toBeNull()
  })

  it('removes the active workspace id and clears cached workspace tokens', () => {
    const localStorage = createLocalStorage({
      'radioso.apiToken': 'radioso_legacy',
      'radioso.workspaceTokens': JSON.stringify({ 'workspace-a': 'radioso_workspace' }),
      'radioso.activeWorkspaceId': 'workspace-a',
    })
    vi.stubGlobal('window', { localStorage })

    removeWorkspaceToken('workspace-a')
    expect(getStoredActiveWorkspaceId()).toBeNull()
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.workspaceTokens')).toBeNull()

    clearWorkspaceStorage()
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.workspaceTokens')).toBeNull()
    expect(localStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
  })
})
