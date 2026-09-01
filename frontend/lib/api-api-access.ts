import { request } from './api-client'
import { withQuery } from './api-query'

export type ApiAccessRole = 'member' | 'admin' | 'owner'
export type CredentialKind = 'personal' | 'service'
export type ApiCredentialStatus = 'active' | 'expired' | 'revoked' | 'suspended' | 'invalid'
export type ServiceAccountStatus = 'enabled' | 'disabled' | 'archived'
export type PersonalTokenView = 'mine' | 'workspace'

export interface ApiCredentialMetadata {
  id: string
  kind: CredentialKind
  label: string
  prefix: string
  roleCeiling: 'member' | 'admin' | null
  status: ApiCredentialStatus
  ownerUserId: string | null
  serviceAccountId: string | null
  createdByUserId: string | null
  createdAt: string
  expiresAt: string | null
  expiryWarningDays: 30 | 7 | 1 | null
  lastUsedAt: string | null
  revokedAt: string | null
  revokedByUserId: string | null
  revocationReason: string | null
  revision: number
  rotatedFromCredentialId: string | null
}

export interface OneTimeCredentialResponse {
  credential: ApiCredentialMetadata
  secret: string
}

export interface PagedApiAccessItems<T> {
  items: T[]
  page: number
  limit: number
  total: number
}

export interface ApiAccessSummary {
  effectiveRole: ApiAccessRole
  capabilities: {
    manageOwnPersonalTokens: boolean
    auditWorkspacePersonalTokens: boolean
    manageServiceAccounts: boolean
  }
  defaults: {
    personalTokenLifetimeDays: null
    serviceCredentialLifetimeDays: null
  }
  limits: {
    personalTokensPerUser: number
    serviceAccountsPerWorkspace: number
    credentialsPerServiceAccount: number
    maximumPageSize: number
  }
  legacyCredentialMigration: {
    status: 'destroyed' | 'not_applicable'
    migratedAt: string | null
  }
  mcpCredentialSupport: 'unsupported'
}

export interface ServiceAccountSummary {
  id: string
  displayName: string
  role: 'member' | 'admin'
  status: ServiceAccountStatus
  createdByUserId: string | null
  createdAt: string
  updatedAt: string
  disabledAt: string | null
  archivedAt: string | null
  lastUsedAt: string | null
  activeCredentialCount: number
  revision: number
}

export interface CreateServiceAccountResponse {
  serviceAccount: ServiceAccountSummary
  credential: ApiCredentialMetadata
  secret: string
}

export interface PersonalTokenInput {
  label: string
  roleCeiling: 'member' | 'admin'
  expiresAt?: string | null
}

export interface ServiceAccountInput {
  displayName: string
  role: 'member' | 'admin'
  initialCredential: {
    label: string
    expiresAt?: string | null
  }
}

export interface ServiceCredentialInput {
  label: string
  expiresAt?: string | null
}

// A required non-simple header prevents cross-site form submission from
// exercising cookie-authenticated credential lifecycle endpoints.
const csrfHeaders = (): HeadersInit => ({ 'X-Radioso-CSRF': '1' })

const sessionRequest = <T>(path: string, init: RequestInit = {}): Promise<T> => request<T>(path, {
  ...init,
  headers: {
    ...csrfHeaders(),
    ...init.headers,
  },
}, { withSession: true })

const basePath = (workspaceId: string) => `/account/workspaces/${encodeURIComponent(workspaceId)}/api-access`
const servicePath = (workspaceId: string, serviceAccountId: string) => `${basePath(workspaceId)}/service-accounts/${encodeURIComponent(serviceAccountId)}`

export const apiAccessApi = {
  getSummary(workspaceId: string): Promise<ApiAccessSummary> {
    return sessionRequest<ApiAccessSummary>(basePath(workspaceId))
  },

  listPersonalTokens(workspaceId: string, input: { view?: PersonalTokenView; page?: number; limit?: number } = {}) {
    return sessionRequest<PagedApiAccessItems<ApiCredentialMetadata>>(withQuery(`${basePath(workspaceId)}/personal-tokens`, input))
  },

  createPersonalToken(workspaceId: string, input: PersonalTokenInput) {
    return sessionRequest<OneTimeCredentialResponse>(`${basePath(workspaceId)}/personal-tokens`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  relabelPersonalToken(workspaceId: string, credentialId: string, label: string, revision: number) {
    return sessionRequest<ApiCredentialMetadata>(`${basePath(workspaceId)}/personal-tokens/${encodeURIComponent(credentialId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label, revision }),
    })
  },

  rotatePersonalToken(workspaceId: string, credentialId: string, revision: number) {
    return sessionRequest<OneTimeCredentialResponse>(`${basePath(workspaceId)}/personal-tokens/${encodeURIComponent(credentialId)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    })
  },

  revokePersonalToken(workspaceId: string, credentialId: string) {
    return sessionRequest<ApiCredentialMetadata>(`${basePath(workspaceId)}/personal-tokens/${encodeURIComponent(credentialId)}/revoke`, {
      method: 'POST',
    })
  },

  listServiceAccounts(workspaceId: string, input: { page?: number; limit?: number } = {}) {
    return sessionRequest<PagedApiAccessItems<ServiceAccountSummary>>(withQuery(`${basePath(workspaceId)}/service-accounts`, input))
  },

  createServiceAccount(workspaceId: string, input: ServiceAccountInput) {
    return sessionRequest<CreateServiceAccountResponse>(`${basePath(workspaceId)}/service-accounts`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  getServiceAccount(workspaceId: string, serviceAccountId: string) {
    return sessionRequest<ServiceAccountSummary>(servicePath(workspaceId, serviceAccountId))
  },

  updateServiceAccount(workspaceId: string, serviceAccountId: string, input: { displayName?: string; role?: 'member' | 'admin'; revision: number }) {
    return sessionRequest<ServiceAccountSummary>(servicePath(workspaceId, serviceAccountId), {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },

  transitionServiceAccount(workspaceId: string, serviceAccountId: string, action: 'disable' | 'enable' | 'archive', revision: number) {
    return sessionRequest<ServiceAccountSummary>(`${servicePath(workspaceId, serviceAccountId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    })
  },

  listServiceCredentials(workspaceId: string, serviceAccountId: string, input: { page?: number; limit?: number } = {}) {
    return sessionRequest<PagedApiAccessItems<ApiCredentialMetadata>>(withQuery(`${servicePath(workspaceId, serviceAccountId)}/credentials`, input))
  },

  issueServiceCredential(workspaceId: string, serviceAccountId: string, input: ServiceCredentialInput) {
    return sessionRequest<OneTimeCredentialResponse>(`${servicePath(workspaceId, serviceAccountId)}/credentials`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  relabelServiceCredential(workspaceId: string, serviceAccountId: string, credentialId: string, label: string, revision: number) {
    return sessionRequest<ApiCredentialMetadata>(`${servicePath(workspaceId, serviceAccountId)}/credentials/${encodeURIComponent(credentialId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label, revision }),
    })
  },

  rotateServiceCredential(workspaceId: string, serviceAccountId: string, credentialId: string, revision: number) {
    return sessionRequest<OneTimeCredentialResponse>(`${servicePath(workspaceId, serviceAccountId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    })
  },

  revokeServiceCredential(workspaceId: string, serviceAccountId: string, credentialId: string) {
    return sessionRequest<ApiCredentialMetadata>(`${servicePath(workspaceId, serviceAccountId)}/credentials/${encodeURIComponent(credentialId)}/revoke`, {
      method: 'POST',
    })
  },
}
