'use client'

import { useEffect, useState } from 'react'

import { accountApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

export function useInlineWorkspaceToken(workspaceId: string | null | undefined) {
  const [apiTokenState, setApiTokenState] = useState<{ workspaceId: string; token: string } | null>(null)
  const [apiTokenErrorState, setApiTokenErrorState] = useState<{ workspaceId: string; error: string } | null>(null)

  useEffect(() => {
    let isCurrent = true

    if (!workspaceId) {
      return undefined
    }

    void accountApi.getWorkspaceToken(workspaceId)
      .then((response) => {
        if (isCurrent) {
          setApiTokenState({ workspaceId, token: response.token })
        }
      })
      .catch((error) => {
        if (isCurrent) {
          setApiTokenErrorState({ workspaceId, error: getApiErrorMessage(error, 'Unable to load API token.') })
        }
      })

    return () => {
      isCurrent = false
    }
  }, [workspaceId])

  const apiToken = workspaceId && apiTokenState?.workspaceId === workspaceId ? apiTokenState.token : null
  const apiTokenError = workspaceId && apiTokenErrorState?.workspaceId === workspaceId ? apiTokenErrorState.error : null
  const isApiTokenLoading = Boolean(workspaceId) && !apiToken && !apiTokenError

  return {
    apiToken,
    apiTokenError: workspaceId ? apiTokenError : 'Select a workspace before viewing its API token.',
    isApiTokenLoading,
  }
}
