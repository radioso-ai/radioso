import { request } from './api-client'

export type OperatorMcpAvailability = 'available' | 'disabled' | 'misconfigured' | 'unavailable'
export type OperatorMcpArtifactStatus = 'verified' | 'unavailable' | 'unverified'
export type OperatorMcpGrantStatus = 'active' | 'revoked' | 'superseded' | 'expired'

export type OperatorMcpToolScope =
  | 'operator:read'
  | 'operator:probe'
  | 'operator:act'
  | 'operator:propose'

export interface OperatorMcpClientSetupArtifact {
  id: string
  displayName: string
  clientVersion: string | null
  status: OperatorMcpArtifactStatus
  description: string
  setupInstructions: readonly string[]
  command: string | null
  configuration: string | null
  handoffUrl: string | null
  permittedLaunchTarget: string
  expectedClientId: string | null
  redirectMechanism: string
  failureRecovery: string
}

export interface OperatorMcpSetupResponse {
  availability: OperatorMcpAvailability
  resource: string | null
  artifacts: OperatorMcpClientSetupArtifact[]
  checkedAt: string
  message: string | null
}

export interface OperatorMcpGrantSummary {
  id: string
  clientId: string
  clientName: string
  clientVersion: string | null
  clientMetadataDigest: string
  workspaceId: string
  workspaceName: string
  userId: string
  userName: string | null
  scopes: OperatorMcpToolScope[]
  offlineAccess: boolean
  status: OperatorMcpGrantStatus
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  revokedReason: string | null
  canRevoke: boolean
  isOwner: boolean
}

export interface OperatorMcpGrantDetail extends OperatorMcpGrantSummary {
  redirectHost: string
  resource: string
  credentialCount: number
  recentInvocationCount: number
}

export interface OperatorMcpGrantInventoryResponse {
  grants: OperatorMcpGrantSummary[]
  canViewWorkspace: boolean
  isLoadingWorkspaceInventory?: boolean
}

export interface OperatorMcpTransactionResponse {
  transactionId: string
  client: {
    clientId: string
    displayName: string
    clientUri: string | null
    clientVersion: string | null
    metadataDigest: string
    applicationType: 'web' | 'native'
  }
  requestedScopes: OperatorMcpToolScope[]
  requestedOfflineAccess: boolean
  redirectHost: string
  redirectUri: string
  resource: string
  currentUser: { id: string; displayName: string; email: string | null }
  workspaces: Array<{ id: string; name: string; role: 'member' | 'admin' | 'owner' }>
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'
  expiresAt: string
}

export interface OperatorMcpDecisionResponse {
  redirectUrl: string
}

const csrfHeaders = (): HeadersInit => ({ 'X-Radioso-CSRF': '1' })

const sessionRequest = <T>(path: string, init: RequestInit = {}): Promise<T> => request<T>(path, {
  ...init,
  headers: { ...csrfHeaders(), ...init.headers },
}, { withSession: true })

const basePath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/operator-mcp`

export const operatorMcpApi = {
  getSetup(workspaceId: string, signal?: AbortSignal): Promise<OperatorMcpSetupResponse> {
    return sessionRequest<OperatorMcpSetupResponse>(`${basePath(workspaceId)}/setup`, { signal })
  },

  listGrants(workspaceId: string, signal?: AbortSignal): Promise<OperatorMcpGrantInventoryResponse> {
    return sessionRequest<OperatorMcpGrantInventoryResponse>(`${basePath(workspaceId)}/grants`, { signal })
  },

  getGrant(workspaceId: string, grantId: string, signal?: AbortSignal): Promise<OperatorMcpGrantDetail> {
    return sessionRequest<OperatorMcpGrantDetail>(`${basePath(workspaceId)}/grants/${encodeURIComponent(grantId)}`, { signal })
  },

  revokeGrant(workspaceId: string, grantId: string): Promise<OperatorMcpGrantSummary> {
    return sessionRequest<OperatorMcpGrantSummary>(`${basePath(workspaceId)}/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: 'POST',
    })
  },

  getTransaction(transactionId: string, signal?: AbortSignal): Promise<OperatorMcpTransactionResponse> {
    return sessionRequest<OperatorMcpTransactionResponse>(`/operator-mcp/oauth/transactions/${encodeURIComponent(transactionId)}`, { signal })
  },

  decideTransaction(transactionId: string, input: {
    decision: 'approve' | 'deny'
    workspaceId?: string
    approvedToolScopes?: OperatorMcpToolScope[]
    offlineAccess: boolean
  }): Promise<OperatorMcpDecisionResponse> {
    return sessionRequest<OperatorMcpDecisionResponse>(`/operator-mcp/oauth/transactions/${encodeURIComponent(transactionId)}/decision`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
}
