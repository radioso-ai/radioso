import {
  API_BASE,
  attachAnonymousSessionHeader,
  buildError,
  persistAnonymousSessionHeader,
  request,
  storeWorkspaceToken,
} from './api-client'
import { withQuery } from './api-query'
import type {
  AccountUsageSummary,
  InternalUsageResponse,
  MessageUsageResponse,
  UsageTrendsResponse,
  AccountUserSummary,
  AccountUsersResponse,
  AnswerFeedbackEntry,
  AnswerFeedbackValue,
  AssignableAccountRole,
  AccessibleAccountsResponse,
  CreateAccountInvitationResponse,
  LoginResponse,
  RenameOrganizationResponse,
  WorkspaceGrantRole,
  WorkspaceGrantSummary,
  WorkspaceTokenResponse,
} from './api-types'

export const enterpriseUsageApi = {
  async getAccountUsage(input?: { period?: string }): Promise<AccountUsageSummary> {
    return request<AccountUsageSummary>(withQuery('/ee/usage-limits/me', {
      period: input?.period,
    }), {
      method: 'GET',
    }, { withSession: true })
  },
}

export const accountApi = {
  async getUsageTrends(input: {
    from: string
    to: string
    granularity: 'day' | 'week' | 'month'
    workspaceId?: string
    agentId?: string
  }): Promise<UsageTrendsResponse> {
    return request<UsageTrendsResponse>(withQuery('/account/usage-trends', input), {
      method: 'GET',
    }, { withSession: true })
  },

  async getMessageUsage(input: {
    from: string
    to: string
    workspaceId?: string
    limit?: number
    cursor?: string
  }): Promise<MessageUsageResponse> {
    return request<MessageUsageResponse>(withQuery('/account/usage/messages', input), {
      method: 'GET',
    }, { withSession: true })
  },

  async getInternalUsage(input: {
    from: string
    to: string
    workspaceId?: string
    limit?: number
    cursor?: string
  }): Promise<InternalUsageResponse> {
    return request<InternalUsageResponse>(withQuery('/account/usage/internal-operations', input), {
      method: 'GET',
    }, { withSession: true })
  },

  async listAccounts(): Promise<AccessibleAccountsResponse> {
    return request<AccessibleAccountsResponse>('/account/accounts', {
      method: 'GET',
    }, { withSession: true })
  },

  async listUsers(): Promise<AccountUsersResponse> {
    return request<AccountUsersResponse>('/account/users', {
      method: 'GET',
    }, { withSession: true })
  },

  async createInvitation(email: string, role: AssignableAccountRole = 'member'): Promise<CreateAccountInvitationResponse> {
    return request<CreateAccountInvitationResponse>('/account/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }, { withSession: true })
  },

  async revokeInvitation(invitationId: string): Promise<void> {
    await request<void>(`/account/invitations/${invitationId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async updateUserRole(membershipId: string, role: AssignableAccountRole): Promise<AccountUserSummary> {
    return request<AccountUserSummary>(`/account/users/${membershipId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }, { withSession: true })
  },

  async removeUser(membershipId: string): Promise<void> {
    await request<void>(`/account/users/${membershipId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async setWorkspaceGrant(workspaceId: string, userId: string, role: WorkspaceGrantRole): Promise<WorkspaceGrantSummary> {
    return request<WorkspaceGrantSummary>(`/account/workspaces/${workspaceId}/grants/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }, { withSession: true })
  },

  async removeWorkspaceGrant(workspaceId: string, userId: string): Promise<void> {
    await request<void>(`/account/workspaces/${workspaceId}/grants/${userId}`, {
      method: 'DELETE',
    }, { withSession: true })
  },

  async switchAccount(accountId: string, preferredWorkspaceId?: string): Promise<LoginResponse> {
    return request<LoginResponse>('/account/switch', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        ...(preferredWorkspaceId ? { preferredWorkspaceId } : {}),
      }),
    }, { withSession: true })
  },

  async createOrganization(organizationName: string): Promise<LoginResponse> {
    return request<LoginResponse>('/account/accounts', {
      method: 'POST',
      body: JSON.stringify({ organizationName }),
    }, { withSession: true })
  },

  async renameOrganization(organizationName: string): Promise<RenameOrganizationResponse> {
    return request<RenameOrganizationResponse>('/account', {
      method: 'PATCH',
      body: JSON.stringify({ organizationName }),
    }, { withSession: true })
  },

  async deleteOrganization(): Promise<void> {
    await request<void>('/account', {
      method: 'DELETE',
    }, { withSession: true })
  },

  async getWorkspaceToken(workspaceId: string): Promise<WorkspaceTokenResponse> {
    const response = await request<WorkspaceTokenResponse>(`/account/workspaces/${workspaceId}/token`, {
      method: 'GET',
    }, { withSession: true })
    storeWorkspaceToken(workspaceId, response.token)
    return response
  },

  async rotateWorkspaceToken(workspaceId: string): Promise<WorkspaceTokenResponse> {
    const response = await request<WorkspaceTokenResponse>(`/account/workspaces/${workspaceId}/token/rotate`, {
      method: 'POST',
    }, { withSession: true })
    storeWorkspaceToken(workspaceId, response.token)
    return response
  },
}

export const answerFeedbackApi = {
  async submit(
    input: { assistantMessageId: string; value: AnswerFeedbackValue; comment?: string | null },
  ): Promise<AnswerFeedbackEntry> {
    return request<AnswerFeedbackEntry>(`/answer-feedback/messages/${input.assistantMessageId}`, {
      method: 'PUT',
      body: JSON.stringify({
        value: input.value,
        comment: input.comment ?? undefined,
      }),
    }, { withApiToken: true })
  },

  async clear(assistantMessageId: string): Promise<{ cleared: boolean }> {
    return request<{ cleared: boolean }>(`/answer-feedback/messages/${assistantMessageId}`, {
      method: 'DELETE',
    }, { withApiToken: true })
  },

  async submitPublic(
    token: string,
    input: { assistantMessageId: string; value: AnswerFeedbackValue; comment?: string | null },
  ): Promise<AnswerFeedbackEntry> {
    const response = await fetch(`${API_BASE}/answer-feedback/public/chat/${encodeURIComponent(token)}/messages/${input.assistantMessageId}`, {
      method: 'PUT',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'Content-Type': 'application/json',
        'X-Forwarded-Prefix': '/backend',
      }),
      body: JSON.stringify({
        value: input.value,
        comment: input.comment ?? undefined,
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<AnswerFeedbackEntry>
  },

  async clearPublic(token: string, assistantMessageId: string): Promise<{ cleared: boolean }> {
    const response = await fetch(`${API_BASE}/answer-feedback/public/chat/${encodeURIComponent(token)}/messages/${assistantMessageId}`, {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'include',
      headers: attachAnonymousSessionHeader(token, {
        'X-Forwarded-Prefix': '/backend',
      }),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    persistAnonymousSessionHeader(token, response)
    return response.json() as Promise<{ cleared: boolean }>
  },
}
