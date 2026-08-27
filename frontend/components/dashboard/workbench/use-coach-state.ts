'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  directivesApi,
  evalsApi,
  workbenchApi,
  type AgentSettings,
  type Directive,
  type DirectiveDraftDirective,
  type DirectiveDraftRequest,
  type DirectiveDraftResponse,
  type DirectiveMutationResponse,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { AgentConfigOverrideInput, WorkbenchReplayRunResponse } from '@/lib/api-eval'
import type { WorkbenchSeedTurn } from './use-workbench-state'

export type CoachStatus = 'idle' | 'drafting' | 'preview' | 'validating' | 'done' | 'error'
export type DirectivesLoadStatus = 'loading' | 'ready' | 'error'

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

export const defaultCoachStateDeps: CoachStateDeps = {
  draftDirective: directivesApi.draftDirective,
  createDirective: directivesApi.createDirective,
  replay: workbenchApi.replay,
  captureSnapshot: evalsApi.captureSnapshot,
}

type ReplayOverrideDirective = NonNullable<AgentConfigOverrideInput['authoredDirectives']>[number]
type ReplaySourceDirective = Pick<ReplayOverrideDirective, 'name' | 'condition' | 'action'> &
  Partial<Omit<ReplayOverrideDirective, 'name' | 'condition' | 'action'>>

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

export const toReplayOverrideDirective = (directive: ReplaySourceDirective): ReplayOverrideDirective => ({
  name: directive.name,
  condition: directive.condition,
  action: directive.action,
  priority: directive.priority ?? null,
  requiredCapabilities: directive.requiredCapabilities ?? [],
  dependsOn: directive.dependsOn ?? [],
  excludes: directive.excludes ?? [],
  surfaces: directive.surfaces ?? [],
  routes: directive.routes ?? [],
  tags: [...(directive.tags ?? [])],
  description: directive.description ?? null,
  metadata: directive.metadata ?? {},
})

export const buildCoachReplayOverride = (
  directive: DirectiveDraftDirective,
  existingDirectives: Directive[] = [],
): Pick<AgentConfigOverrideInput, 'authoredDirectives'> => ({
  authoredDirectives: [
    ...existingDirectives.map(toReplayOverrideDirective),
    toReplayOverrideDirective(directive),
  ],
})

export function useCoachState({
  selectedAgent,
  seedTurn,
  existingDirectives = [],
  directivesStatus,
  deps,
  initialSnapshotId = null,
}: {
  selectedAgent: AgentSettings
  seedTurn: WorkbenchSeedTurn | null
  existingDirectives?: Directive[]
  directivesStatus: DirectivesLoadStatus
  deps?: Partial<CoachStateDeps>
  initialSnapshotId?: string | null
}) {
  const resolvedDeps = useMemo(
    () => ({ ...defaultCoachStateDeps, ...(deps ?? {}) }),
    [deps],
  )
  const [state, setState] = useState<CoachState>({
    status: 'idle',
    preview: null,
    savedDirective: null,
    error: null,
  })
  const [snapshotId, setSnapshotId] = useState<string | null>(initialSnapshotId)
  const seedIdentity = `${seedTurn?.conversation.conversationId ?? ''}:${seedTurn?.assistantTurn?.id ?? ''}`

  useEffect(() => {
    setSnapshotId(initialSnapshotId)
    setState({
      status: 'idle',
      preview: null,
      savedDirective: null,
      error: null,
    })
  }, [initialSnapshotId, seedIdentity])

  const canSubmit = useMemo(
    () => (
      directivesStatus === 'ready'
      && Boolean(seedTurn?.assistantTurn)
      && state.status !== 'drafting'
      && state.status !== 'validating'
    ),
    [directivesStatus, seedTurn?.assistantTurn, state.status],
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
    if (directivesStatus !== 'ready') {
      setState((current) => ({
        ...current,
        status: 'error',
        error: directivesStatus === 'loading'
          ? 'Wait for existing directives to load before drafting coaching.'
          : "Couldn't load existing directives. Reload before coaching so the preview matches what gets saved.",
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
      const draft = await resolvedDeps.draftDirective(
        selectedAgent.id,
        buildCoachDraftRequest(trimmed, seedTurn),
      )
      const activeSnapshotId = snapshotId
        ?? (await resolvedDeps.captureSnapshot({
          conversationId: seedTurn.conversation.conversationId,
          messageId: seedTurn.assistantTurn.id,
        })).id
      setSnapshotId(activeSnapshotId)
      const replay = await resolvedDeps.replay({
        snapshotId: activeSnapshotId,
        agentConfigOverride: buildCoachReplayOverride(draft.directive, existingDirectives),
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
  }, [directivesStatus, existingDirectives, resolvedDeps, seedTurn, selectedAgent.id, snapshotId])

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
      const response = await resolvedDeps.createDirective(selectedAgent.id, {
        name: draft.directive.name,
        condition: draft.directive.condition,
        action: draft.directive.action,
        tags: draft.directive.tags,
        // The preview replays with the drafted scope, so the save must persist the
        // same one — otherwise a suggestion-scoped draft previews correctly and then
        // lands on the answer.
        surfaces: draft.directive.surfaces ?? [],
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
  }, [resolvedDeps, selectedAgent.id, state.preview])

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
