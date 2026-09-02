'use client'

import { useEffect, useRef, useState } from 'react'

import {
  agentChannelCredentialsApi,
  type AgentChannelCredential,
  type AgentChannelCredentialAudience,
  type IssuedAgentChannelCredential,
} from '@/lib/api-agent-channel-credentials'
import { getApiErrorMessage } from '@/lib/api-error'

export const agentChannelAudienceName = (audience: AgentChannelCredentialAudience): string =>
  audience === 'mcp' ? 'MCP' : 'Agent API'

export interface AgentChannelCredentialEngine {
  busyCredentialId: string | null
  credentials: AgentChannelCredential[]
  error: string | null
  hasMore: boolean
  isCreating: boolean
  isLoading: boolean
  isLoadingMore: boolean
  issued: IssuedAgentChannelCredential | null
  clearIssued: () => void
  issue: (input: { label: string; expiresAt: string }) => Promise<boolean>
  loadMore: () => Promise<void>
  revoke: (credentialId: string) => Promise<boolean>
  rotate: (credentialId: string) => Promise<boolean>
}

/**
 * List, issue, rotate, and revoke state for one agent's channel credentials. Every
 * write is fenced by a scope generation so a response from a previous agent or
 * audience can never land in the current scope's inventory or secret dialog.
 */
export function useAgentChannelCredentials(
  agentId: string,
  audience: AgentChannelCredentialAudience,
): AgentChannelCredentialEngine {
  const [credentials, setCredentials] = useState<AgentChannelCredential[]>([])
  const [issued, setIssued] = useState<IssuedAgentChannelCredential | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [busyCredentialId, setBusyCredentialId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scopeGeneration = useRef(0)
  const audienceName = agentChannelAudienceName(audience)

  useEffect(() => {
    const generation = scopeGeneration.current + 1
    scopeGeneration.current = generation
    let active = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- scope changes clear agent-bound state before loading the new scope.
    setCredentials([])
    setIssued(null)
    setIsLoadingMore(false)
    setIsCreating(false)
    setBusyCredentialId(null)
    setError(null)
    setNextCursor(null)
    setIsLoading(true)
    void agentChannelCredentialsApi.list(agentId, audience)
      .then((response) => {
        if (active && scopeGeneration.current === generation) {
          setCredentials(response.credentials)
          setNextCursor(response.nextCursor)
        }
      })
      .catch((loadError: unknown) => {
        if (active && scopeGeneration.current === generation) {
          setError(getApiErrorMessage(loadError, `Failed to load ${agentChannelAudienceName(audience)} credentials.`))
        }
      })
      .finally(() => {
        if (active && scopeGeneration.current === generation) setIsLoading(false)
      })
    return () => {
      active = false
      if (scopeGeneration.current === generation) scopeGeneration.current += 1
    }
  }, [agentId, audience])

  const loadMore = async () => {
    if (!nextCursor || isLoadingMore) return
    const generation = scopeGeneration.current
    setIsLoadingMore(true)
    setError(null)
    try {
      const response = await agentChannelCredentialsApi.list(agentId, audience, { cursor: nextCursor })
      if (scopeGeneration.current !== generation) return
      setCredentials((current) => [
        ...current,
        ...response.credentials.filter((incoming) => !current.some((existing) => existing.id === incoming.id)),
      ])
      setNextCursor(response.nextCursor)
    } catch (loadError: unknown) {
      if (scopeGeneration.current === generation) {
        setError(getApiErrorMessage(loadError, `Failed to load more ${audienceName} credentials.`))
      }
    } finally {
      if (scopeGeneration.current === generation) setIsLoadingMore(false)
    }
  }

  const issue = async ({ label, expiresAt }: { label: string; expiresAt: string }) => {
    const generation = scopeGeneration.current
    setIsCreating(true)
    setError(null)
    try {
      const next = await agentChannelCredentialsApi.issue(agentId, { audience, label, expiresAt })
      if (scopeGeneration.current !== generation) return false
      setIssued(next)
      setCredentials((current) => [next.credential, ...current.filter((credential) => credential.id !== next.credential.id)])
      return true
    } catch (createError: unknown) {
      if (scopeGeneration.current === generation) {
        setError(getApiErrorMessage(createError, `Failed to create ${audienceName} credential.`))
      }
      return false
    } finally {
      if (scopeGeneration.current === generation) setIsCreating(false)
    }
  }

  const rotate = async (credentialId: string) => {
    const generation = scopeGeneration.current
    setBusyCredentialId(credentialId)
    setError(null)
    try {
      const next = await agentChannelCredentialsApi.rotate(agentId, credentialId)
      if (scopeGeneration.current !== generation) return false
      setIssued(next)
      setCredentials((current) => current.map((credential) => credential.id === next.credential.id ? next.credential : credential))
      return true
    } catch (rotateError: unknown) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(rotateError, 'Failed to rotate credential.'))
      return false
    } finally {
      if (scopeGeneration.current === generation) setBusyCredentialId(null)
    }
  }

  const revoke = async (credentialId: string) => {
    const generation = scopeGeneration.current
    setBusyCredentialId(credentialId)
    setError(null)
    try {
      await agentChannelCredentialsApi.revoke(agentId, credentialId)
      if (scopeGeneration.current !== generation) return false
      setCredentials((current) => current.map((credential) => credential.id === credentialId
        ? { ...credential, status: 'revoked', revokedAt: new Date().toISOString() }
        : credential))
      setIssued((current) => current?.credential.id === credentialId ? null : current)
      return true
    } catch (revokeError: unknown) {
      if (scopeGeneration.current === generation) setError(getApiErrorMessage(revokeError, 'Failed to revoke credential.'))
      return false
    } finally {
      if (scopeGeneration.current === generation) setBusyCredentialId(null)
    }
  }

  return {
    busyCredentialId,
    clearIssued: () => setIssued(null),
    credentials,
    error,
    hasMore: nextCursor !== null,
    isCreating,
    isLoading,
    isLoadingMore,
    issue,
    issued,
    loadMore,
    revoke,
    rotate,
  }
}
