'use client'

import { useCallback, useMemo, useState } from 'react'

import {
  directivesApi,
  evalsApi,
  workbenchApi,
  type AgentSettings,
  type DirectiveDraftDirective,
  type DirectiveDraftRequest,
  type DirectiveDraftResponse,
  type DirectiveMutationResponse,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { WorkbenchReplayRunResponse } from '@/lib/api-eval'
import type { WorkbenchSeedTurn } from './use-workbench-state'

export type CoachStatus = 'idle' | 'drafting' | 'preview' | 'validating' | 'done' | 'error'

export interface CoachPreview {
  draft: DirectiveDraftResponse
  replay: WorkbenchReplayRunResponse
}

export interface CoachState {
  status: CoachStatus
  preview: CoachPreview | null
  savedDirective: DirectiveMutationResponse['directive'] | null
  error: string | null
}

export interface CoachStateDeps {
  draftDirective: typeof directivesApi.draftDirective
  createDirective: typeof directivesApi.createDirective
  replay: typeof workbenchApi.replay
  captureSnapshot: typeof evalsApi.captureSnapshot
}

const defaultDeps: CoachStateDeps = {
  draftDirective: directivesApi.draftDirective,
  createDirective: directivesApi.createDirective,
  replay: workbenchApi.replay,
  captureSnapshot: evalsApi.captureSnapshot,
}

export const buildCoachDraftRequest = (
  coachingText: string,
  seedTurn: WorkbenchSeedTurn,
): DirectiveDraftRequest => ({
  coachingText,
  turn: {
    userMessage: seedTurn.userTurn.content,
    assistantAnswer: seedTurn.assistantTurn?.content ?? '',
  },
})

export const buildCoachReplayOverride = (
  directive: DirectiveDraftDirective,
): { authoredDirectives: Array<Record<string, unknown>> } => ({
  authoredDirectives: [{
    name: directive.name,
    condition: directive.condition,
    action: directive.action,
    tags: [...directive.tags],
  }],
})

export function useCoachState({
  selectedAgent,
  seedTurn,
  deps = defaultDeps,
}: {
  selectedAgent: AgentSettings
  seedTurn: WorkbenchSeedTurn | null
  deps?: CoachStateDeps
}) {
  const [state, setState] = useState<CoachState>({
    status: 'idle',
    preview: null,
    savedDirective: null,
    error: null,
  })
  const [snapshotId, setSnapshotId] = useState<string | null>(null)

  const canSubmit = useMemo(
    () => Boolean(seedTurn?.assistantTurn) && state.status !== 'drafting' && state.status !== 'validating',
    [seedTurn?.assistantTurn, state.status],
  )

  const submitCoaching = useCallback(async (coachingText: string) => {
    const trimmed = coachingText.trim()
    if (!seedTurn?.assistantTurn) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: 'Load an assistant turn before coaching.',
      }))
      return
    }
    if (!trimmed) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: 'Add coaching before drafting a directive.',
      }))
      return
    }

    setState({
      status: 'drafting',
      preview: null,
      savedDirective: null,
      error: null,
    })

    try {
      const draft = await deps.draftDirective(
        selectedAgent.id,
        buildCoachDraftRequest(trimmed, seedTurn),
      )
      const activeSnapshotId = snapshotId
        ?? (await deps.captureSnapshot({
          conversationId: seedTurn.conversation.conversationId,
          messageId: seedTurn.assistantTurn.id,
        })).id
      setSnapshotId(activeSnapshotId)
      const replay = await deps.replay({
        snapshotId: activeSnapshotId,
        agentConfigOverride: buildCoachReplayOverride(draft.directive),
      })
      setState({
        status: 'preview',
        preview: { draft, replay },
        savedDirective: null,
        error: null,
      })
    } catch (error) {
      setState({
        status: 'error',
        preview: null,
        savedDirective: null,
        error: getApiErrorMessage(error, 'Failed to draft and preview coaching.'),
      })
    }
  }, [deps, seedTurn, selectedAgent.id, snapshotId])

  const validate = useCallback(async () => {
    if (!state.preview) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: 'Draft coaching before validating it.',
      }))
      return
    }

    setState((current) => ({
      ...current,
      status: 'validating',
      error: null,
    }))

    const { draft } = state.preview
    try {
      const response = await deps.createDirective(selectedAgent.id, {
        name: draft.directive.name,
        condition: draft.directive.condition,
        action: draft.directive.action,
        tags: draft.directive.tags,
        metadata: {
          diagnosis: draft.diagnosis,
          ...(draft.rationale ? { rationale: draft.rationale } : {}),
        },
      })
      setState((current) => ({
        ...current,
        status: 'done',
        savedDirective: response.directive,
        error: null,
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        status: 'error',
        error: getApiErrorMessage(error, 'Failed to validate coaching.'),
      }))
    }
  }, [deps, selectedAgent.id, state.preview])

  const reset = useCallback(() => {
    setState({
      status: 'idle',
      preview: null,
      savedDirective: null,
      error: null,
    })
  }, [])

  return {
    ...state,
    canSubmit,
    submitCoaching,
    validate,
    reset,
  }
}
