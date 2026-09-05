/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The recovery path (bootstrap falling back to GET /auth/session) only exists inside
// AuthProvider's effect, so it is exercised by rendering the provider rather than by calling a
// pure helper. Everything else in `@/lib/api` stays real: `seedWorkspaceSession` and
// `clearWorkspaceStorage` are asserted on via their actual localStorage side effects below.
const apiMocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      getCurrentSession: apiMocks.getCurrentSession,
    },
  }
})

import {
  AuthProvider,
  getStoredLastAccountId,
  mergeStoredAccountOrganizationNames,
  readStoredAuthUser,
  storeAccountOrganizationName,
  useAuth,
} from '@/lib/auth-context'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

// Renders as plain DOM attributes so assertions can read bootstrap state without a testing
// library, matching this repo's manual createRoot/act component-test convention.
function AuthProbe() {
  const { user, isAuthenticated, isBootstrapping } = useAuth()
  return (
    <div
      data-testid="auth-probe"
      data-bootstrapping={String(isBootstrapping)}
      data-authenticated={String(isAuthenticated)}
      data-email={user?.email ?? ''}
    />
  )
}

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
      'radioso.activeWorkspaceId': 'workspace-1',
    })
    vi.stubGlobal('window', { localStorage })

    expect(readStoredAuthUser(localStorage)).toBeNull()
    expect(localStorage.getItem('radioso.authUser')).toBeNull()
    expect(localStorage.getItem('radioso.lastAccountId')).toBeNull()
    expect(localStorage.getItem('radioso.apiToken')).toBeNull()
    expect(localStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
  })
})

describe('AuthProvider bootstrap effect', () => {
  let container: HTMLDivElement
  let root: Root

  const sessionFixture = {
    userId: 'session-user-1',
    accountId: 'session-account-1',
    organizationName: 'Session Org',
    workspaceId: 'session-workspace-1',
    workspaceName: 'Default',
    workspacePublicRouteKey: 'session-org-key',
    requiresEmailVerification: false,
    email: 'recovered@example.com',
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- querySelector returns Element; the assertion is what gives callers `.dataset`.
  const probe = () => document.querySelector('[data-testid="auth-probe"]') as HTMLElement | null

  beforeEach(() => {
    apiMocks.getCurrentSession.mockReset()
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    window.localStorage.clear()
  })

  it('renders a stored user immediately and never calls GET /auth/session', async () => {
    window.localStorage.setItem('radioso.authUser', JSON.stringify({
      userId: 'stored-user-1',
      accountId: 'stored-account-1',
      email: 'stored@example.com',
    }))

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>,
      )
    })

    expect(probe()?.dataset.bootstrapping).toBe('false')
    expect(probe()?.dataset.authenticated).toBe('true')
    expect(probe()?.dataset.email).toBe('stored@example.com')
    expect(apiMocks.getCurrentSession).not.toHaveBeenCalled()
  })

  it('recovers a live session when local storage is empty and persists it', async () => {
    apiMocks.getCurrentSession.mockResolvedValueOnce(sessionFixture)

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>,
      )
    })

    expect(apiMocks.getCurrentSession).toHaveBeenCalledOnce()
    expect(probe()?.dataset.bootstrapping).toBe('false')
    expect(probe()?.dataset.authenticated).toBe('true')
    expect(probe()?.dataset.email).toBe('recovered@example.com')

    expect(JSON.parse(window.localStorage.getItem('radioso.authUser') ?? 'null')).toEqual({
      userId: sessionFixture.userId,
      accountId: sessionFixture.accountId,
      email: sessionFixture.email,
      organizationName: sessionFixture.organizationName,
    })
    expect(window.localStorage.getItem('radioso.lastAccountId')).toBe(sessionFixture.accountId)
    // Seeded via `seedWorkspaceSession`, the real implementation from `@/lib/api` — this is the
    // step that used to be missing, which is why a provider OAuth return looked signed out.
    expect(window.localStorage.getItem('radioso.activeWorkspaceId')).toBe(sessionFixture.workspaceId)
    expect(window.localStorage.getItem('radioso.activeWorkspacePublicRouteKey')).toBe(sessionFixture.workspacePublicRouteKey)
  })

  it('stays signed out when local storage is empty and there is no live session', async () => {
    apiMocks.getCurrentSession.mockResolvedValueOnce(null)

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>,
      )
    })

    expect(apiMocks.getCurrentSession).toHaveBeenCalledOnce()
    expect(probe()?.dataset.bootstrapping).toBe('false')
    expect(probe()?.dataset.authenticated).toBe('false')
    expect(probe()?.dataset.email).toBe('')
    expect(window.localStorage.getItem('radioso.authUser')).toBeNull()
    expect(window.localStorage.getItem('radioso.activeWorkspaceId')).toBeNull()
  })
})
