import type { ApiCredentialMetadata, ServiceAccountSummary } from '@/lib/api'

import { formatCredentialDate } from './credential-dialogs'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

type ExpiringCredential = Pick<ApiCredentialMetadata, 'expiresAt' | 'expiryWarningDays' | 'status'>

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * Backend-owned warning window: `expiryWarningDays` is present only once a credential is close
 * enough to expiry to be worth saying so. Outside that window the row stays quiet.
 */
export const isExpiringSoon = (credential: ExpiringCredential): boolean =>
  credential.status === 'active' && credential.expiryWarningDays !== null && Boolean(credential.expiresAt)

/** Amber badge copy for a credential inside the warning window, or null when there is nothing to warn about. */
export const expiringSoonLabel = (credential: ExpiringCredential, now: Date = new Date()): string | null => {
  if (!isExpiringSoon(credential) || !credential.expiresAt) return null
  const remainingDays = Math.ceil((new Date(credential.expiresAt).getTime() - now.getTime()) / MILLISECONDS_PER_DAY)
  if (!Number.isFinite(remainingDays)) return null
  if (remainingDays <= 0) return 'Expires today'
  return `Expires in ${plural(remainingDays, 'day')}`
}

/** Exceptional states only: a healthy credential carries no badge. */
export const credentialStatusBadge = (credential: Pick<ApiCredentialMetadata, 'status'>): string | null =>
  credential.status === 'active'
    ? null
    : `${credential.status.charAt(0).toUpperCase()}${credential.status.slice(1)}`

export const serviceAccountStatusBadge = (account: Pick<ServiceAccountSummary, 'status'>): string | null =>
  account.status === 'enabled'
    ? null
    : `${account.status.charAt(0).toUpperCase()}${account.status.slice(1)}`

/** Row meta: prefix · role when it is not the default · owner when it is not you · expiry when near · last used. */
export const credentialRowMeta = (
  credential: ApiCredentialMetadata,
  options: { ownerName?: string | null } = {},
): string => {
  const facts = [credential.prefix]
  if (credential.roleCeiling === 'admin') facts.push('Admin')
  if (options.ownerName) facts.push(options.ownerName)
  if (isExpiringSoon(credential) && credential.expiresAt) facts.push(`Expires ${formatCredentialDate(credential.expiresAt)}`)
  facts.push(`Last used ${formatCredentialDate(credential.lastUsedAt)}`)
  if (credential.revokedAt) facts.push(`Revoked ${formatCredentialDate(credential.revokedAt)}`)
  return facts.join(' · ')
}

export const serviceAccountRowMeta = (account: ServiceAccountSummary): string => {
  const facts: string[] = []
  if (account.role === 'admin') facts.push('Admin')
  facts.push(plural(account.activeCredentialCount, 'credential'))
  facts.push(`Last used ${formatCredentialDate(account.lastUsedAt)}`)
  return facts.join(' · ')
}

/** Header meta for the service-account sheet: only the facts this record actually carries. */
export const serviceAccountDetailMeta = (
  account: ServiceAccountSummary,
  createdByName: string | null,
): string => {
  const created = formatCredentialDate(account.createdAt)
  const facts = [createdByName ? `Created by ${createdByName} · ${created}` : `Created ${created}`]
  if (account.status === 'disabled' && account.disabledAt) facts.push(`Disabled ${formatCredentialDate(account.disabledAt)}`)
  if (account.archivedAt) facts.push(`Archived ${formatCredentialDate(account.archivedAt)}`)
  if (account.lastUsedAt) facts.push(`Last used ${formatCredentialDate(account.lastUsedAt)}`)
  return facts.join(' · ')
}

export const activeCredentialConsequence = (activeCredentialCount: number): string =>
  `Revokes its ${plural(activeCredentialCount, 'active credential')} immediately. Cannot be undone.`
