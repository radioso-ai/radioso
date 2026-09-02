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

vi.mock('@/lib/api', () => ({ apiAccessApi: apiMocks }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: { userId: 'user-1' } }) }))

import { ApiAccessPanel } from '@/components/dashboard/settings/api-access-panel'

const summary = {
  effectiveRole: 'admin' as const,
  capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: true, manageServiceAccounts: true },
  defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
  limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
  legacyCredentialMigration: { status: 'destroyed' as const, migratedAt: null },
}

const personalCredential = {
  id: 'credential-1', kind: 'personal' as const, label: 'CLI token', prefix: 'rdso_cli', roleCeiling: 'admin' as const,
  status: 'active' as const, ownerUserId: 'user-1', serviceAccountId: null, createdByUserId: 'creator-1',
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', expiryWarningDays: null,
  lastUsedAt: null, revokedAt: null, revokedByUserId: null, revocationReason: null, revision: 1, rotatedFromCredentialId: null,
}

const serviceAccount = {
  id: 'service-1', displayName: 'Nightly ingestion', role: 'admin' as const, status: 'enabled' as const,
  createdByUserId: 'creator-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  disabledAt: null, archivedAt: null, lastUsedAt: null, activeCredentialCount: 1, revision: 1,
}

const serviceCredential = {
  ...personalCredential,
  id: 'service-credential-1', kind: 'service' as const, label: 'Production worker', ownerUserId: null, serviceAccountId: 'service-1',
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const findButton = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes(text))

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('prompt', vi.fn(() => 'Renamed'))
})

describe('ApiAccessPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    apiMocks.getSummary.mockResolvedValue(summary)
    apiMocks.listPersonalTokens.mockResolvedValue({ items: [], page: 1, limit: 50, total: 0 })
    apiMocks.createPersonalToken.mockResolvedValue({ credential: personalCredential, secret: 'one-time-secret' })
    apiMocks.listServiceAccounts.mockResolvedValue({ items: [serviceAccount], page: 1, limit: 50, total: 1 })
    apiMocks.getServiceAccount.mockResolvedValue(serviceAccount)
    apiMocks.listServiceCredentials.mockResolvedValue({ items: [serviceCredential], page: 1, limit: 50, total: 1 })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('ignores a delayed load from the previous workspace', async () => {
    const oldSummary = deferred<typeof summary>()
    const currentSummary = deferred<typeof summary>()
    apiMocks.getSummary.mockReset()
    apiMocks.getSummary.mockReturnValueOnce(oldSummary.promise).mockReturnValueOnce(currentSummary.promise)
    apiMocks.listPersonalTokens.mockResolvedValue({ items: [], page: 1, limit: 50, total: 0 })

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-old" />)
    })
    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-current" />)
    })

    await act(async () => {
      oldSummary.resolve({ ...summary, capabilities: { ...summary.capabilities, auditWorkspacePersonalTokens: false } })
    })
    expect(container.textContent).not.toContain('Personal credentials across this workspace')

    await act(async () => {
      currentSummary.resolve(summary)
    })
    expect(container.textContent).toContain('Personal credentials across this workspace')
  })

  it('renders operator-facing credential inventory metadata without internal identifiers', async () => {
    apiMocks.listPersonalTokens.mockResolvedValue({ items: [personalCredential], page: 1, limit: 50, total: 1 })

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-1" />)
    })

    expect(container.textContent).toContain('Kind personal')
    expect(container.textContent).toContain('Status Active')
    expect(container.textContent).toContain('Owner You')
    expect(container.textContent).toContain('Created by a workspace member')
    expect(container.textContent).toContain('Created 1/1/2026')
    expect(container.textContent).not.toContain('user-1')
    expect(container.textContent).not.toContain('creator-1')
  })

  it('ignores a delayed one-time secret from a previous workspace mutation', async () => {
    const create = deferred<{ credential: typeof personalCredential; secret: string }>()
    apiMocks.createPersonalToken.mockReturnValue(create.promise)

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-old" />)
    })
    await act(async () => {
      findButton('Create personal token', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const label = document.querySelector<HTMLInputElement>('#personal-token-label')
    expect(label).toBeTruthy()
    setInputValue(label!, 'Old token')
    await act(async () => {
      findButton('Issue personal token', document.body)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-current" />)
    })
    await act(async () => {
      create.resolve({ credential: personalCredential, secret: 'stale-secret' })
    })

    expect(document.body.textContent).not.toContain('Save this secret now')
    expect(document.body.innerHTML).not.toContain('stale-secret')
  })

  it('ignores delayed service details from a previous workspace', async () => {
    const oldDetails = deferred<typeof serviceAccount>()
    const oldCredentials = deferred<{ items: typeof serviceCredential[]; page: number; limit: number; total: number }>()
    apiMocks.getServiceAccount.mockReturnValueOnce(oldDetails.promise)
    apiMocks.listServiceCredentials.mockReturnValueOnce(oldCredentials.promise)

    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-old" view="service" />)
    })
    await act(async () => {
      findButton('Manage credentials', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      root.render(<ApiAccessPanel workspaceId="workspace-current" view="service" />)
    })
    await act(async () => {
      oldDetails.resolve({ ...serviceAccount, displayName: 'Old workspace account' })
      oldCredentials.resolve({ items: [{ ...serviceCredential, label: 'Old workspace credential' }], page: 1, limit: 50, total: 1 })
    })

    expect(container.textContent).not.toContain('Old workspace account credentials')
    expect(container.textContent).not.toContain('Old workspace credential')
  })
})
