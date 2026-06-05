import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getStoredLastAccountId,
  mergeStoredAccountOrganizationNames,
  readStoredAuthUser,
  storeAccountOrganizationName,
} from '@/lib/auth-context'

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

describe('auth session bootstrap', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the stored auth user when bootstrap data is valid', () => {
    const localStorage = createLocalStorage({
      'radioso.authUser': JSON.stringify({
        userId: 'user-1',
        accountId: 'account-1',
        email: 'alice@example.com',
        organizationName: 'Coop Pank',
      }),
    })
    vi.stubGlobal('window', { localStorage })

    expect(readStoredAuthUser(localStorage)).toEqual({
      userId: 'user-1',
      accountId: 'account-1',
      email: 'alice@example.com',
      organizationName: 'Coop Pank',
    })
  })

  it('backfills accountId from userId for legacy bootstrap data', () => {
    const localStorage = createLocalStorage({
      'radioso.authUser': JSON.stringify({ userId: 'user-1', email: 'alice@example.com' }),
    })

    expect(readStoredAuthUser(localStorage)).toEqual({
      userId: 'user-1',
      accountId: 'user-1',
      email: 'alice@example.com',
    })
  })

  it('reads the last signed-in account id', () => {
    const localStorage = createLocalStorage({
      'radioso.lastAccountId': 'account-42',
    })

    expect(getStoredLastAccountId(localStorage)).toBe('account-42')
  })

  it('uses cached organization names to repair duplicated accessible account labels by account id', () => {
    const localStorage = createLocalStorage()
    storeAccountOrganizationName(localStorage, 'account-1', 'Coop Pank')
    storeAccountOrganizationName(localStorage, 'account-2', 'Radioso')

    expect(mergeStoredAccountOrganizationNames([
      { accountId: 'account-1', organizationName: 'Radioso' },
      { accountId: 'account-2', organizationName: 'Radioso' },
      { accountId: 'account-3', organizationName: 'Migrevention' },
    ], localStorage)).toEqual([
      { accountId: 'account-1', organizationName: 'Coop Pank' },
      { accountId: 'account-2', organizationName: 'Radioso' },
      { accountId: 'account-3', organizationName: 'Migrevention' },
    ])
  })

  it('keeps unique accessible account labels from the current account response', () => {
    const localStorage = createLocalStorage()
    storeAccountOrganizationName(localStorage, 'account-1', 'Old Name')

    expect(mergeStoredAccountOrganizationNames([
      { accountId: 'account-1', organizationName: 'New Name' },
      { accountId: 'account-2', organizationName: 'Radioso' },
    ], localStorage)).toEqual([
      { accountId: 'account-1', organizationName: 'New Name' },
      { accountId: 'account-2', organizationName: 'Radioso' },
    ])
  })

  it('clears invalid auth bootstrap data and legacy workspace tokens', () => {
    const localStorage = createLocalStorage({
      'radioso.authUser': '{not-json',
      'radioso.lastAccountId': 'account-stale',
      'radioso.apiToken': 'radioso_legacy_token',
      'radioso.workspaceTokens': JSON.stringify({ 'workspace-1': 'radioso_workspace_token' }),
      'radioso.activeWorkspaceId': 'workspace-1',
    })
    vi.stubGlobal('window', { localStorage })

    expect(readStoredAuthUser(localStorage)).toBeNull()
    expect(localStorage.getItem('radioso.authUser')).toBeNull()
    expect(localStorage.getItem('radioso.lastAccountId')).toBeNull()
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.workspaceTokens')).toBeNull()
    expect(localStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
  })
})
