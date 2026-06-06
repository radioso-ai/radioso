'use client'

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'

import {
  chatApi,
  directivesApi,
  evalsApi,
  workbenchApi,
  type AgentSettings,
  type ChatConversationDetail,
  type ChatConversationTurn,
  type Directive,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import type { AgentConfigOverrideInput, EvalRunModelOverride, WorkbenchReplayRunResponse } from '@/lib/api-eval'
import {
  readRetrievalSkillSettingsOverride,
  RETRIEVAL_ANSWER_SKILL_NAME,
  type RetrievalSkillSettingsOverride,
} from '@/lib/retrieval-skill-settings'
import type { ActivityTrace, TurnTraceEnvelope } from '@/lib/api-types'

export type WorkbenchOverrideField =
  | 'chatModelOverride'
  | 'customInstruction'
  | 'retrievalSkillSettings'
  | 'authoredDirectives'

export interface WorkbenchOverrideValues {
  chatModelOverride: EvalRunModelOverride | null
  customInstruction: string
  retrievalSkillSettings: RetrievalSkillSettingsOverride
  authoredDirectives: Array<Record<string, unknown>>
}

export interface WorkbenchOverrideState {
  touched: Record<WorkbenchOverrideField, boolean>
  values: WorkbenchOverrideValues
}

export type WorkbenchOverrideAction =
  | { type: 'set-model'; value: EvalRunModelOverride | null }
  | { type: 'set-custom-instruction'; value: string }
  | { type: 'set-retrieval-skill-settings'; value: RetrievalSkillSettingsOverride }
  | { type: 'set-authored-directives'; value: Array<Record<string, unknown>> }
  | { type: 'clear-field'; field: WorkbenchOverrideField }
  | { type: 'reset'; baseline: WorkbenchOverrideValues }

export interface WorkbenchSeed {
  conversationId: string
  sourceMessageId?: string
}

export interface WorkbenchSeedTurn {
  conversation: ChatConversationDetail
  userTurn: ChatConversationTurn
  assistantTurn: ChatConversationTurn | null
}

export interface WorkbenchRunCard {
  id: string
  answer: string
  citations: WorkbenchReplayRunResponse['citations']
  answerSegments: WorkbenchReplayRunResponse['answerSegments']
  turnTrace?: TurnTraceEnvelope
  activityTrace?: ActivityTrace
  resolvedConfig: Record<string, unknown>
  status: WorkbenchReplayRunResponse['run']['status']
  startedAt: string
  completedAt: string | null
}

const emptyTouched: Record<WorkbenchOverrideField, boolean> = {
  chatModelOverride: false,
  customInstruction: false,
  retrievalSkillSettings: false,
  authoredDirectives: false,
}

const cloneBaseline = (baseline: WorkbenchOverrideValues): WorkbenchOverrideValues => ({
  chatModelOverride: baseline.chatModelOverride ? { ...baseline.chatModelOverride } : null,
  customInstruction: baseline.customInstruction,
  retrievalSkillSettings: { ...baseline.retrievalSkillSettings },
  authoredDirectives: baseline.authoredDirectives.map((directive) => ({ ...directive })),
})

export const buildWorkbenchBaseline = (
  agent: AgentSettings,
  directives: Directive[] = [],
): WorkbenchOverrideValues => ({
  chatModelOverride: agent.chatModelOverride
    ? { provider: agent.chatModelOverride.provider, model: agent.chatModelOverride.model }
    : null,
  customInstruction: agent.customInstruction ?? '',
  retrievalSkillSettings: readRetrievalSkillSettingsOverride(agent.skillSettings),
  authoredDirectives: directives.map((directive) => ({ ...directive })),
})

export const createWorkbenchOverrideState = (
  baseline: WorkbenchOverrideValues,
): WorkbenchOverrideState => ({
  touched: { ...emptyTouched },
  values: {
    ...cloneBaseline(baseline),
    retrievalSkillSettings: {},
  },
})

const isRecordEmpty = (value: Record<string, unknown>) => Object.keys(value).length === 0

export const buildAgentConfigOverrideDelta = (
  state: WorkbenchOverrideState,
): AgentConfigOverrideInput => {
  const delta: AgentConfigOverrideInput = {}

  if (state.touched.chatModelOverride) {
    delta.chatModelOverride = state.values.chatModelOverride
  }
  if (state.touched.customInstruction) {
    delta.customInstruction = state.values.customInstruction
  }
  if (state.touched.retrievalSkillSettings) {
    delta.skillSettings = {
      [RETRIEVAL_ANSWER_SKILL_NAME]: { ...state.values.retrievalSkillSettings },
    }
  }
  if (state.touched.authoredDirectives) {
    delta.authoredDirectives = state.values.authoredDirectives
  }

  return delta
}

export const isWorkbenchOverrideDeltaEmpty = (state: WorkbenchOverrideState): boolean =>
  isRecordEmpty(buildAgentConfigOverrideDelta(state) as Record<string, unknown>)

export const workbenchOverrideReducer = (
  state: WorkbenchOverrideState,
  action: WorkbenchOverrideAction,
): WorkbenchOverrideState => {
  switch (action.type) {
    case 'set-model':
      return {
        touched: { ...state.touched, chatModelOverride: true },
        values: { ...state.values, chatModelOverride: action.value ? { ...action.value } : null },
      }
    case 'set-custom-instruction':
      return {
        touched: { ...state.touched, customInstruction: true },
        values: { ...state.values, customInstruction: action.value },
      }
    case 'set-retrieval-skill-settings':
      return {
        touched: { ...state.touched, retrievalSkillSettings: true },
        values: { ...state.values, retrievalSkillSettings: { ...action.value } },
      }
    case 'set-authored-directives':
      return {
        touched: { ...state.touched, authoredDirectives: true },
        values: { ...state.values, authoredDirectives: action.value.map((directive) => ({ ...directive })) },
      }
    case 'clear-field':
      return {
        touched: { ...state.touched, [action.field]: false },
        values: { ...state.values },
      }
    case 'reset':
      return createWorkbenchOverrideState(action.baseline)
  }
}

export const findSeedTurn = (
  conversation: ChatConversationDetail,
  sourceMessageId?: string,
): WorkbenchSeedTurn | null => {
  const messages = conversation.messages
  if (messages.length === 0) {
    return null
  }

  if (sourceMessageId) {
    const messageIndex = messages.findIndex((message) => message.id === sourceMessageId)
    if (messageIndex < 0) {
      return null
    }
    const selected = messages[messageIndex]
    if (selected.role === 'user') {
      const assistantTurn = messages.slice(messageIndex + 1).find((message) => message.role === 'assistant') ?? null
      return { conversation, userTurn: selected, assistantTurn }
    }
    const userTurn = messages.slice(0, messageIndex).reverse().find((message) => message.role === 'user')
    return userTurn ? { conversation, userTurn, assistantTurn: selected.role === 'assistant' ? selected : null } : null
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const assistantTurn = messages[index]
    if (assistantTurn.role !== 'assistant') continue
    const userTurn = messages.slice(0, index).reverse().find((message) => message.role === 'user')
    if (userTurn) {
      return { conversation, userTurn, assistantTurn }
    }
  }

  const userTurn = messages.find((message) => message.role === 'user')
  return userTurn ? { conversation, userTurn, assistantTurn: null } : null
}

export const mapReplayResultToRunCard = (
  result: WorkbenchReplayRunResponse,
): WorkbenchRunCard => ({
  id: result.run.id,
  answer: result.answer ?? result.run.observedOutput.answer ?? '',
  citations: result.citations ?? result.run.observedOutput.citations,
  answerSegments: result.answerSegments ?? result.run.observedOutput.answerSegments,
  turnTrace: result.turnTrace ?? result.run.observedOutput.turnTrace,
  activityTrace: result.run.observedOutput.activityTrace,
  resolvedConfig: result.resolvedConfig ?? result.run.resolvedConfig,
  status: result.run.status,
  startedAt: result.run.startedAt,
  completedAt: result.run.completedAt,
})

export function useWorkbenchState({
  selectedAgent,
  seed,
}: {
  selectedAgent: AgentSettings
  seed?: WorkbenchSeed
}) {
  const [directives, setDirectives] = useState<Directive[]>([])
  const baseline = useMemo(
    () => buildWorkbenchBaseline(selectedAgent, directives),
    [directives, selectedAgent],
  )
  const [overrideState, dispatchOverride] = useReducer(
    workbenchOverrideReducer,
    baseline,
    createWorkbenchOverrideState,
  )
  const [seedTurn, setSeedTurn] = useState<WorkbenchSeedTurn | null>(null)
  const [snapshotId, setSnapshotId] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkbenchRunCard[]>([])
  const [isSeedLoading, setIsSeedLoading] = useState(Boolean(seed?.conversationId))
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dispatchOverride({ type: 'reset', baseline })
  }, [baseline])

  useEffect(() => {
    let cancelled = false
    void directivesApi.listDirectives(selectedAgent.id)
      .then((response) => {
        if (!cancelled) setDirectives(response.directives)
      })
      .catch(() => {
        if (!cancelled) setDirectives([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedAgent.id])

  useEffect(() => {
    if (!seed?.conversationId) {
      const timeout = window.setTimeout(() => {
        setSeedTurn(null)
        setSnapshotId(null)
        setIsSeedLoading(false)
      }, 0)
      return () => window.clearTimeout(timeout)
    }

    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Syncs replay seed loading state from the current route seed.
    setIsSeedLoading(true)
    setError(null)
    void chatApi.getHistoryConversation(seed.conversationId)
      .then((conversation) => {
        if (cancelled) return
        const nextSeedTurn = findSeedTurn(conversation, seed.sourceMessageId)
        setSeedTurn(nextSeedTurn)
        if (!nextSeedTurn) {
          setError('Could not find a replayable turn in that conversation.')
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setSeedTurn(null)
          setError(getApiErrorMessage(loadError, 'Failed to load the seeded conversation.'))
        }
      })
      .finally(() => {
        if (!cancelled) setIsSeedLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [seed?.conversationId, seed?.sourceMessageId])

  const delta = useMemo(() => buildAgentConfigOverrideDelta(overrideState), [overrideState])
  const isDeltaEmpty = useMemo(() => isWorkbenchOverrideDeltaEmpty(overrideState), [overrideState])

  const runReplay = useCallback(async () => {
    if (!seedTurn) {
      setError('Load a past turn before running a replay.')
      return
    }
    if (isDeltaEmpty) {
      setError('Enable at least one override before running a replay.')
      return
    }

    setIsRunning(true)
    setError(null)
    try {
      const activeSnapshotId = snapshotId
        ?? (await evalsApi.captureSnapshot({
          conversationId: seedTurn.conversation.conversationId,
          messageId: seedTurn.assistantTurn?.id ?? seedTurn.userTurn.id,
        })).id
      setSnapshotId(activeSnapshotId)
      const result = await workbenchApi.replay({
        snapshotId: activeSnapshotId,
        agentConfigOverride: delta,
      })
      setRuns((current) => [mapReplayResultToRunCard(result), ...current])
    } catch (runError) {
      setError(getApiErrorMessage(runError, 'Replay failed.'))
    } finally {
      setIsRunning(false)
    }
  }, [delta, isDeltaEmpty, seedTurn, snapshotId])

  return {
    baseline,
    delta,
    directives,
    dispatchOverride,
    error,
    isDeltaEmpty,
    isRunning,
    isSeedLoading,
    overrideState,
    runReplay,
    runs,
    seedTurn,
  }
}
