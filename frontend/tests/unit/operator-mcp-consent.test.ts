/* @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { OperatorMcpConsent, consentWarnings } from '@/components/operator-mcp/operator-mcp-consent'
import type { OperatorMcpTransactionResponse } from '@/lib/api-operator-mcp'
import { AuthProvider } from '@/lib/auth-context'

const operatorMcpApiMocks = vi.hoisted(() => ({
  decideTransaction: vi.fn(),
  getTransaction: vi.fn(),
}))

vi.mock('@/lib/api-operator-mcp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api-operator-mcp')>(),
  operatorMcpApi: operatorMcpApiMocks,
}))

vi.mock('@/components/auth/auth-page', async () => {
  const React = await import('react')
  return {
    AuthPage: ({ returnTo }: { returnTo?: string }) => React.createElement('div', { 'data-testid': 'auth-page', 'data-return-to': returnTo }, 'Welcome back'),
  }
})

const transaction = (redirectUri: string): OperatorMcpTransactionResponse => ({
  transactionId: 'tx-1',
  client: {
    clientId: 'https://client.example/metadata',
    displayName: 'Example client',
    clientUri: 'https://client.example',
    clientVersion: '1.0.0',
    metadataDigest: 'digest',
    applicationType: 'web',
  },
  requestedScopes: ['operator:read'],
  requestedOfflineAccess: false,
  redirectHost: new URL(redirectUri).hostname,
  redirectUri,
  resource: 'https://mcp.example/operator/mcp',
  currentUser: { id: 'user-1', displayName: 'A User', email: 'a@example.com' },
  workspaces: [{ id: 'workspace-1', name: 'Workspace', role: 'member' }],
  status: 'pending',
  expiresAt: '2026-09-04T12:00:00.000Z',
})

describe('operator MCP consent warnings', () => {
  it('always warns about external client data access', () => {
    expect(consentWarnings(transaction('https://client.example/callback'))[0]).toContain('may receive workspace data')
  })

  it('adds a warning for loopback redirects', () => {
    expect(consentWarnings(transaction('http://127.0.0.1:3210/callback'))).toHaveLength(2)
  })

  it('does not classify an ordinary HTTPS redirect as loopback', () => {
    expect(consentWarnings(transaction('https://client.example/callback'))).toHaveLength(1)
  })
})

describe('OperatorMcpConsent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    localStorage.clear()
    operatorMcpApiMocks.getTransaction.mockReset()
    operatorMcpApiMocks.decideTransaction.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders login instead of a generic unavailable state when the transaction API returns 401', async () => {
    localStorage.setItem('radioso.authUser', JSON.stringify({
      userId: 'user-1',
      accountId: 'account-1',
      email: 'user@example.com',
    }))
    operatorMcpApiMocks.getTransaction.mockRejectedValueOnce({
      status: 401,
      error: { code: 'unauthorized', message: 'Unauthorized' },
    })

    await act(async () => {
      root.render(createElement(AuthProvider, null, createElement(OperatorMcpConsent, { transactionId: 'tx-1' })))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Welcome back')
    expect(container.textContent).not.toContain('Authorization unavailable')
    expect(operatorMcpApiMocks.getTransaction).toHaveBeenCalledWith('tx-1', expect.any(AbortSignal))
    expect(container.querySelector('[data-testid="auth-page"]')?.getAttribute('data-return-to')).toBe('/oauth/operator-mcp/consent?transaction=tx-1')
  })

  it('renders login after the server rejects a browser without client auth bootstrap', async () => {
    operatorMcpApiMocks.getTransaction.mockRejectedValueOnce({
      status: 401,
      error: { code: 'unauthorized', message: 'Unauthorized' },
    })

    await act(async () => {
      root.render(createElement(AuthProvider, null, createElement(OperatorMcpConsent, { transactionId: 'tx-1' })))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Welcome back')
    expect(operatorMcpApiMocks.getTransaction).toHaveBeenCalledWith('tx-1', expect.any(AbortSignal))
    expect(container.querySelector('[data-testid="auth-page"]')?.getAttribute('data-return-to')).toBe('/oauth/operator-mcp/consent?transaction=tx-1')
  })

  it('uses a valid server session when the client auth cache is absent after federated login', async () => {
    operatorMcpApiMocks.getTransaction.mockResolvedValueOnce(transaction('http://127.0.0.1:3210/callback'))

    await act(async () => {
      root.render(createElement(AuthProvider, null, createElement(OperatorMcpConsent, { transactionId: 'tx-1' })))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Authorize Radioso MCP')
    expect(container.textContent).toContain('Example client')
    expect(container.textContent).not.toContain('Welcome back')
  })
})
