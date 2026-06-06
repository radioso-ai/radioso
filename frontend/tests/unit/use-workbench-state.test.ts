import { describe, expect, it } from 'vitest'

import {
  buildAgentConfigOverrideDelta,
  createWorkbenchOverrideState,
  findSeedTurn,
  isWorkbenchOverrideDeltaEmpty,
  mapReplayResultToRunCard,
  workbenchOverrideReducer,
  type WorkbenchOverrideValues,
} from '@/components/dashboard/workbench/use-workbench-state'
import { RETRIEVAL_ANSWER_SKILL_NAME } from '@/lib/retrieval-skill-settings'
import type { ChatConversationDetail } from '@/lib/api'
import type { WorkbenchReplayRunResponse } from '@/lib/api-eval'

const baseline: WorkbenchOverrideValues = {
  chatModelOverride: { provider: 'openai', model: 'gpt-5.3' },
  customInstruction: 'Default instruction',
  retrievalSkillSettings: { vectorTopK: 8, retrievalStrategy: 'auto' },
  authoredDirectives: [{ id: 'directive-1', title: 'Default directive' }],
}

describe('workbench override state', () => {
  it('starts with an empty delta even when baseline fields have values', () => {
    const state = createWorkbenchOverrideState(baseline)

    expect(isWorkbenchOverrideDeltaEmpty(state)).toBe(true)
    expect(buildAgentConfigOverrideDelta(state)).toEqual({})
  })

  it('includes only touched override fields in the agent config payload', () => {
    let state = createWorkbenchOverrideState(baseline)
    state = workbenchOverrideReducer(state, { type: 'set-custom-instruction', value: '' })
    state = workbenchOverrideReducer(state, {
      type: 'set-retrieval-skill-settings',
      value: { vectorTopK: 3, retrievalStrategy: 'fixed' },
    })

    expect(buildAgentConfigOverrideDelta(state)).toEqual({
      customInstruction: '',
      skillSettings: {
        [RETRIEVAL_ANSWER_SKILL_NAME]: { vectorTopK: 3, retrievalStrategy: 'fixed' },
      },
    })
  })

  it('omits cleared fields after they were previously touched', () => {
    let state = createWorkbenchOverrideState(baseline)
    state = workbenchOverrideReducer(state, {
      type: 'set-model',
      value: { provider: 'gemini', model: 'gemini-2.5-pro' },
    })
    state = workbenchOverrideReducer(state, { type: 'clear-field', field: 'chatModelOverride' })

    expect(buildAgentConfigOverrideDelta(state)).toEqual({})
  })

  it('can explicitly disable authored directives', () => {
    const state = workbenchOverrideReducer(
      createWorkbenchOverrideState(baseline),
      { type: 'set-authored-directives', value: [] },
    )

    expect(buildAgentConfigOverrideDelta(state)).toEqual({ authoredDirectives: [] })
  })
})

describe('workbench seed mapping', () => {
  const conversation = {
    id: 'conversation-1',
    messages: [
      { id: 'u1', role: 'user', content: 'First question', createdAt: '2026-06-01T10:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'First answer', createdAt: '2026-06-01T10:00:01.000Z' },
      { id: 'u2', role: 'user', content: 'Second question', createdAt: '2026-06-01T10:01:00.000Z' },
      { id: 'a2', role: 'assistant', content: 'Second answer', createdAt: '2026-06-01T10:01:01.000Z' },
    ],
  } as unknown as ChatConversationDetail

  it('maps a selected assistant message back to its user turn', () => {
    expect(findSeedTurn(conversation, 'a1')).toMatchObject({
      userTurn: { id: 'u1' },
      assistantTurn: { id: 'a1' },
    })
  })

  it('uses the latest assistant answer when no message id is provided', () => {
    expect(findSeedTurn(conversation)).toMatchObject({
      userTurn: { id: 'u2' },
      assistantTurn: { id: 'a2' },
    })
  })
})

describe('workbench run-card mapping', () => {
  it('prefers top-level replay output and envelope trace when present', () => {
    const result = {
      answer: 'Top-level answer',
      citations: [],
      turnTrace: { schemaVersion: 1, spine: { stages: [] } },
      resolvedConfig: { modelId: 'gpt-5.4' },
      run: {
        id: 'run-1',
        status: 'recorded',
        startedAt: '2026-06-01T10:00:00.000Z',
        completedAt: '2026-06-01T10:00:02.000Z',
        overrides: { agentConfigOverride: { customInstruction: 'Replay tone' } },
        resolvedConfig: { modelId: 'older' },
        observedOutput: {
          retrievedChunks: [],
          answer: 'Nested answer',
          turnTrace: { schemaVersion: 1, spine: { stages: [{ id: 'nested' }] } },
        },
      },
      case: null,
    } as unknown as WorkbenchReplayRunResponse

    expect(mapReplayResultToRunCard(result)).toMatchObject({
      id: 'run-1',
      answer: 'Top-level answer',
      turnTrace: result.turnTrace,
      resolvedConfig: { modelId: 'gpt-5.4' },
      agentConfigOverride: { customInstruction: 'Replay tone' },
    })
  })

  it('falls back to legacy activity trace from observed output', () => {
    const activityTrace = {
      traceId: 'trace-1',
      startedAt: '2026-06-01T10:00:00.000Z',
      stages: [],
      links: [],
    }
    const result = {
      run: {
        id: 'run-2',
        status: 'recorded',
        startedAt: '2026-06-01T10:00:00.000Z',
        completedAt: null,
        overrides: {},
        resolvedConfig: {},
        observedOutput: {
          retrievedChunks: [],
          answer: 'Nested answer',
          activityTrace,
        },
      },
      case: null,
    } as unknown as WorkbenchReplayRunResponse

    expect(mapReplayResultToRunCard(result)).toMatchObject({
      answer: 'Nested answer',
      activityTrace,
    })
  })
})
