import { describe, expect, it } from 'vitest'

import type { ApiCredentialMetadata, ServiceAccountSummary } from '@/lib/api'
import {
  activeCredentialConsequence,
  credentialRowMeta,
  credentialStatusBadge,
  expiringSoonLabel,
  serviceAccountDetailMeta,
  serviceAccountRowMeta,
  serviceAccountStatusBadge,
} from '@/components/dashboard/settings/api-access-row-meta'
import { formatCredentialDate } from '@/components/dashboard/settings/credential-dialogs'

const CREATED_AT = '2026-02-09T12:00:00.000Z'
const EXPIRES_AT = '2026-09-11T12:00:00.000Z'
const USED_AT = '2026-08-12T12:00:00.000Z'
const REVOKED_AT = '2026-08-30T12:00:00.000Z'

const credential = (overrides: Partial<ApiCredentialMetadata> = {}): ApiCredentialMetadata => ({
  id: 'credential-1',
  kind: 'personal',
  label: 'Local development',
  prefix: 'radioso_pat_v1_8kQz',
  roleCeiling: 'member',
  status: 'active',
  ownerUserId: 'user-1',
  serviceAccountId: null,
  createdByUserId: 'user-1',
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
  expiryWarningDays: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null,
  revision: 1,
  rotatedFromCredentialId: null,
  ...overrides,
})

const account = (overrides: Partial<ServiceAccountSummary> = {}): ServiceAccountSummary => ({
  id: 'service-1',
  displayName: 'Nightly ingestion',
  role: 'member',
  status: 'enabled',
  createdByUserId: 'user-1',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  disabledAt: null,
  archivedAt: null,
  lastUsedAt: null,
  activeCredentialCount: 1,
  revision: 1,
  ...overrides,
})

describe('credential row meta', () => {
  it('stays quiet about an expiry outside the warning window', () => {
    expect(credentialRowMeta(credential())).toBe('radioso_pat_v1_8kQz · Last used never')
    expect(expiringSoonLabel(credential())).toBeNull()
  })

  it('counts the days left once inside the warning window', () => {
    const expiring = credential({ expiryWarningDays: 30 })

    expect(expiringSoonLabel(expiring, new Date('2026-09-02T12:00:00.000Z'))).toBe('Expires in 9 days')
    expect(expiringSoonLabel(expiring, new Date('2026-09-10T12:00:00.000Z'))).toBe('Expires in 1 day')
    expect(expiringSoonLabel(expiring, new Date('2026-09-11T12:00:00.000Z'))).toBe('Expires today')
    expect(credentialRowMeta(expiring)).toContain(`Expires ${formatCredentialDate(EXPIRES_AT)}`)
  })

  it('drops the expiry warning once the credential is no longer active', () => {
    expect(expiringSoonLabel(credential({ expiryWarningDays: 7, status: 'revoked' }))).toBeNull()
  })

  it('adds the role only when it exceeds the default and the owner only when one is supplied', () => {
    expect(credentialRowMeta(credential({ roleCeiling: 'admin' }))).toContain('Admin')
    expect(credentialRowMeta(credential())).not.toContain('Admin')
    expect(credentialRowMeta(credential(), { ownerName: 'marta@example.com' }))
      .toBe('radioso_pat_v1_8kQz · marta@example.com · Last used never')
  })

  it('reports revocation in the row meta and badges only exceptional states', () => {
    expect(credentialStatusBadge(credential())).toBeNull()
    expect(credentialStatusBadge(credential({ status: 'revoked' }))).toBe('Revoked')
    expect(credentialRowMeta(credential({ status: 'revoked', revokedAt: REVOKED_AT })))
      .toContain(`Revoked ${formatCredentialDate(REVOKED_AT)}`)
  })
})

describe('service account meta', () => {
  it('counts credentials and hides the default role', () => {
    expect(serviceAccountRowMeta(account())).toBe('1 credential · Last used never')
    expect(serviceAccountRowMeta(account({ role: 'admin', activeCredentialCount: 2, lastUsedAt: USED_AT })))
      .toBe(`Admin · 2 credentials · Last used ${formatCredentialDate(USED_AT)}`)
  })

  it('badges only a status that is not enabled', () => {
    expect(serviceAccountStatusBadge(account())).toBeNull()
    expect(serviceAccountStatusBadge(account({ status: 'disabled' }))).toBe('Disabled')
    expect(serviceAccountStatusBadge(account({ status: 'archived' }))).toBe('Archived')
  })

  it('states only the facts a record carries', () => {
    const created = formatCredentialDate(CREATED_AT)

    expect(serviceAccountDetailMeta(account(), 'you')).toBe(`Created by you · ${created}`)
    expect(serviceAccountDetailMeta(account(), null)).toBe(`Created ${created}`)
    expect(serviceAccountDetailMeta(account({ status: 'disabled', disabledAt: USED_AT }), 'you'))
      .toBe(`Created by you · ${created} · Disabled ${formatCredentialDate(USED_AT)}`)
  })

  it('counts the credentials an archive would end', () => {
    expect(activeCredentialConsequence(1)).toBe('Revokes its 1 active credential immediately. Cannot be undone.')
    expect(activeCredentialConsequence(3)).toBe('Revokes its 3 active credentials immediately. Cannot be undone.')
  })
})
