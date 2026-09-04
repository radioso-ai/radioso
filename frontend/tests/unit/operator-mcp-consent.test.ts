import { describe, expect, it } from 'vitest'

import { consentWarnings } from '@/components/operator-mcp/operator-mcp-consent'
import type { OperatorMcpTransactionResponse } from '@/lib/api-operator-mcp'

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
