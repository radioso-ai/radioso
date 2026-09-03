/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getSummary: vi.fn(),
  listPersonalTokens: vi.fn(),
  createPersonalToken: vi.fn(),
  relabelPersonalToken: vi.fn(),
  rotatePersonalToken: vi.fn(),
  revokePersonalToken: vi.fn(),
  listServiceAccounts: vi.fn(),
  createServiceAccount: vi.fn(),
  getServiceAccount: vi.fn(),
  updateServiceAccount: vi.fn(),
  transitionServiceAccount: vi.fn(),
  listServiceCredentials: vi.fn(),
  issueServiceCredential: vi.fn(),
  relabelServiceCredential: vi.fn(),
  rotateServiceCredential: vi.fn(),
  revokeServiceCredential: vi.fn(),
}))
const accountMocks = vi.hoisted(() => ({ listUsers: vi.fn() }))

vi.mock('@/lib/api', () => ({ apiAccessApi: apiMocks, accountApi: accountMocks }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { userId: 'user-1' } }) }))

import { ApiAccessPanel } from '@/components/dashboard/settings/api-access-panel'

const summary = (overrides: { manageServiceAccounts?: boolean; auditWorkspacePersonalTokens?: boolean } = {}) => ({
  effectiveRole: 'admin' as const,
  capabilities: {
    manageOwnPersonalTokens: true,
    auditWorkspacePersonalTokens: overrides.auditWorkspacePersonalTokens ?? false,
    manageServiceAccounts: overrides.manageServiceAccounts ?? false,
  },
  defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
  limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
  legacyCredentialMigration: { status: 'destroyed' as const, migratedAt: null },
})

const personalCredential = {
  id: 'credential-1', kind: 'personal' as const, label: 'CLI token', prefix: 'rdso_cli', roleCeiling: 'admin' as const,
  status: 'active' as const, ownerUserId: 'user-1', serviceAccountId: null, createdByUserId: 'user-1',
  createdAt: '2026-01-01T12:00:00.000Z', expiresAt: '2027-01-01T12:00:00.000Z', expiryWarningDays: null,
  lastUsedAt: null, revokedAt: null, revokedByUserId: null, revocationReason: null, revision: 1, rotatedFromCredentialId: null,
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const findButton = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === text)

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('ApiAccessPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    apiMocks.getSummary.mockResolvedValue(summary())
    apiMocks.listPersonalTokens.mockResolvedValue({ items: [], page: 1, limit: 50, total: 0 })
    apiMocks.listServiceAccounts.mockResolvedValue({ items: [], page: 1, limit: 50, total: 0 })
    accountMocks.listUsers.mockResolvedValue({ users: [] })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('ignores capabilities that arrive from the previous workspace', async () => {
    const previous = deferred<ReturnType<typeof summary>>()
    const current = deferred<ReturnType<typeof summary>>()
    apiMocks.getSummary.mockReset()
    apiMocks.getSummary.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-old" />)
    })
    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-current" />)
    })

    await act(async () => {
      previous.resolve(summary({ manageServiceAccounts: true }))
    })
    expect(apiMocks.listServiceAccounts).not.toHaveBeenCalled()

    await act(async () => {
      current.resolve(summary({ manageServiceAccounts: false }))
    })
    expect(apiMocks.listServiceAccounts).not.toHaveBeenCalled()
    expect(apiMocks.listPersonalTokens).toHaveBeenCalledWith('workspace-current', { view: 'mine', page: 1 })
    expect(apiMocks.listPersonalTokens).not.toHaveBeenCalledWith('workspace-old', expect.anything())
  })

  it('never shows a one-time secret issued against a workspace the operator has left', async () => {
    const create = deferred<{ credential: typeof personalCredential; secret: string }>()
    apiMocks.createPersonalToken.mockReturnValue(create.promise)

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-old" />)
    })
    await act(async () => {
      findButton('Create token', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const label = document.querySelector<HTMLInputElement>('#personal-token-label')
    expect(label).toBeTruthy()
    setInputValue(label!, 'Old token')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[type="submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(apiMocks.createPersonalToken).toHaveBeenCalledWith('workspace-old', expect.objectContaining({ label: 'Old token' }))

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-current" />)
    })
    await act(async () => {
      create.resolve({ credential: personalCredential, secret: 'stale-secret' })
    })

    expect(document.body.innerHTML).not.toContain('stale-secret')
  })

  it('lists everyone else’s tokens separately from your own, and only for an auditor', async () => {
    apiMocks.getSummary.mockResolvedValue(summary({ auditWorkspacePersonalTokens: true }))

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-1" />)
    })

    expect(apiMocks.listPersonalTokens).toHaveBeenCalledWith('workspace-1', { view: 'mine', page: 1 })
    expect(apiMocks.listPersonalTokens).toHaveBeenCalledWith('workspace-1', { view: 'workspace', page: 1 })
  })

  it('asks only for your own tokens when you cannot audit the workspace', async () => {
    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-1" />)
    })

    expect(apiMocks.listPersonalTokens).toHaveBeenCalledTimes(1)
    expect(apiMocks.listPersonalTokens).toHaveBeenCalledWith('workspace-1', { view: 'mine', page: 1 })
    expect(apiMocks.listServiceAccounts).not.toHaveBeenCalled()
  })
})
