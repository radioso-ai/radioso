'use client'

import {
  type AgentSettings,
  type ChatConversationDetail,
  type ChatConversationTurn,
  type Directive,
} from '@/lib/api'
import type {
  AgentConfigAuthoredDirectiveOverride,
  AgentConfigOverrideInput,
  EvalRunModelOverride,
  EvalRunRoutineStartStateInput,
  WorkbenchReplayRunResponse,
} from '@/lib/api-eval'
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
  | 'routineStartState'

export interface WorkbenchOverrideValues {
  chatModelOverride: EvalRunModelOverride | null
  customInstruction: string
  retrievalSkillSettings: RetrievalSkillSettingsOverride
  authoredDirectives: AgentConfigAuthoredDirectiveOverride[]
  // A mid-routine starting position to resume the agent's routine from, or null to let
  // routines activate fresh. Not part of the agentConfigOverride delta — it is a
  // separate replay override sent under `overrides.routineStartState`.
  routineStartState: EvalRunRoutineStartStateInput | null
}

export interface WorkbenchOverrideState {
  touched: Record<WorkbenchOverrideField, boolean>
  values: WorkbenchOverrideValues
}

export type WorkbenchOverrideAction =
  | { type: 'set-model'; value: EvalRunModelOverride | null }
  | { type: 'set-custom-instruction'; value: string }
  | { type: 'set-retrieval-skill-settings'; value: RetrievalSkillSettingsOverride }
  | { type: 'set-authored-directives'; value: AgentConfigAuthoredDirectiveOverride[] }
  | { type: 'set-routine-start-state'; value: EvalRunRoutineStartStateInput | null }
  | { type: 'clear-field'; field: WorkbenchOverrideField }
  | { type: 'reset'; baseline: WorkbenchOverrideValues }

export interface WorkbenchSeedTurn {
  conversation: ChatConversationDetail
  userTurn: ChatConversationTurn
  assistantTurn: ChatConversationTurn | null
}

interface WorkbenchRunCard {
  id: string
  answer: string
  citations: WorkbenchReplayRunResponse['citations']
  answerSegments: WorkbenchReplayRunResponse['answerSegments']
  turnTrace?: TurnTraceEnvelope
  activityTrace?: ActivityTrace
  resolvedConfig: Record<string, unknown>
  agentConfigOverride?: AgentConfigOverrideInput
  status: WorkbenchReplayRunResponse['run']['status']
  startedAt: string
  completedAt: string | null
}

const emptyTouched: Record<WorkbenchOverrideField, boolean> = {
  chatModelOverride: false,
  customInstruction: false,
  retrievalSkillSettings: false,
  authoredDirectives: false,
  routineStartState: false,
}

const cloneBaseline = (baseline: WorkbenchOverrideValues): WorkbenchOverrideValues => ({
  chatModelOverride: baseline.chatModelOverride ? { ...baseline.chatModelOverride } : null,
  customInstruction: baseline.customInstruction,
  retrievalSkillSettings: { ...baseline.retrievalSkillSettings },
  authoredDirectives: baseline.authoredDirectives.map((directive) => ({ ...directive })),
  routineStartState: baseline.routineStartState,
})
export const isRoutineStartStateReady = (
  value: EvalRunRoutineStartStateInput | null | undefined,
): value is EvalRunRoutineStartStateInput =>
  Boolean(value?.routineId && value.path.length > 0)

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
  // Replay defaults to no routine seed (routines activate fresh from the turn).
  routineStartState: null,
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
    case 'set-routine-start-state':
      return {
        touched: { ...state.touched, routineStartState: true },
        values: { ...state.values, routineStartState: action.value },
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
  agentConfigOverride: result.run.overrides.agentConfigOverride as AgentConfigOverrideInput | undefined,
  status: result.run.status,
  startedAt: result.run.startedAt,
  completedAt: result.run.completedAt,
})
