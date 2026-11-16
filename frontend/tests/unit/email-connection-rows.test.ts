import { describe, expect, it } from 'vitest'

import {
  emailConnectionRowSummary,
  hasEmailConnectionProblem,
  healthCheckResultMessage,
  healthLabel,
} from '@/components/dashboard/settings/email-connection-rows'
import type { CustomerEmailConnection } from '@/lib/api'

const connection = (overrides: Partial<CustomerEmailConnection> = {}): CustomerEmailConnection => ({
  id: 'connection-1',
  workspaceId: 'workspace-1',
  oauthConnectionId: 'oauth-1',
  displayName: 'Support outbound',
  provider: 'google_mail',
  senderEmail: 'support@example.com',
  status: 'authorized',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('email connection rows', () => {
  it('summarises the sender and the provider', () => {
    expect(emailConnectionRowSummary(connection())).toBe('support@example.com · Google Gmail')
    expect(emailConnectionRowSummary(connection({ senderName: 'Support Team', provider: 'microsoft_graph_mail' })))
      .toBe('Support Team <support@example.com> · Microsoft 365 Outlook')
  })

  it('names an unknown provider by its id rather than hiding the row', () => {
    expect(emailConnectionRowSummary(connection({ provider: 'future_mail' }))).toBe('support@example.com · future_mail')
  })

  it('badges only a connection that cannot send mail on its own', () => {
    expect(hasEmailConnectionProblem('needs_reauth')).toBe(true)
    expect(hasEmailConnectionProblem('error')).toBe(true)
    expect(hasEmailConnectionProblem('authorized')).toBe(false)
    expect(hasEmailConnectionProblem('disabled')).toBe(false)
  })

  it('words a health check by what it found', () => {
    expect(healthCheckResultMessage('ok')).toBe('Health check passed.')
    expect(healthCheckResultMessage('failed')).toBe('Health check failed.')
    expect(healthCheckResultMessage('unknown')).toBe('Health check was inconclusive.')
    expect(healthLabel(null)).toBe('Not checked')
    expect(healthLabel(undefined)).toBe('Not checked')
  })
})
