import { describe, expect, it } from 'vitest'

import {
  presentActivityOutcome,
  presentRunParameters,
} from '@/lib/activity-diagnostics'
import type { ActivityTrace, ChatConversationTurnDebug } from '@/lib/api'

const baseTrace = (stages: ActivityTrace['stages'], summary: ActivityTrace['summary'] = {}): ActivityTrace => ({
  traceId: 'trace-1',
  startedAt: '2026-05-17T00:00:00.000Z',
  stages,
  links: stages.slice(0, -1).map((stage, index) => ({
    fromStageId: stage.stageId,
    toStageId: stages[index + 1]?.stageId ?? stage.stageId,
    kind: 'sequence',
  })),
  summary,
})

describe('activity diagnostics presentation', () => {
  it('summarizes a contact workflow without exposing raw route chips', () => {
    const trace = baseTrace(
      [
        {
          stageId: 'availability_check',
          kind: 'availability_check',
          label: 'Availability check',
          status: 'applied',
          outputs: { configured: true },
        },
        {
          stageId: 'request_submit',
          kind: 'request_submit',
          label: 'Request submit',
          status: 'applied',
          outputs: { requestId: 'request-1' },
        },
      ],
      { status: 'pending', outcome: 'human_followup_queued' },
    )

    const presentation = presentActivityOutcome({ trace })

    expect(presentation.title).toBe('Human follow-up queued')
    expect(presentation.summary).toContain('queued a contact request')
    expect(presentation.facts).toContainEqual({ label: 'Workflow', value: 'Human follow-up' })
    expect(presentation.facts).not.toContainEqual({ label: 'Document search', value: 'Not used' })
  })

  it('consolidates retrieval run parameters from trace stages', () => {
    const trace = baseTrace([
      {
        stageId: 'context',
        kind: 'context',
        label: 'Context',
        status: 'applied',
        settings: {
          queryRewriteEnabled: true,
          vectorTopK: 12,
          similarityThreshold: 0.72,
          rerankEnabled: true,
          rerankTopK: 8,
        },
      },
      {
        stageId: 'selection',
        kind: 'context_selection',
        label: 'Context selection',
        status: 'applied',
        settings: { effectiveRerankEnabled: true, rerankTopK: 8 },
      },
      {
        stageId: 'prompt',
        kind: 'prompt_assembly',
        label: 'Prompt assembly',
        status: 'applied',
        settings: {
          citationDisplayEnabled: true,
          answerSupportValidationEnabled: true,
          responseLanguagePolicy: 'match_user_question',
        },
      },
    ])

    const presentation = presentRunParameters(trace)

    expect(presentation?.title).toBe('Retrieval parameters')
    expect(presentation?.facts).toContainEqual({ label: 'Query rewrite', value: 'Enabled' })
    expect(presentation?.facts).toContainEqual({ label: 'Meaning search limit', value: '12' })
    expect(presentation?.facts).toContainEqual({ label: 'Support validation', value: 'Enabled' })
  })

  it('summarizes direct answers as agent activity instead of missing retrieval', () => {
    const route = {
      generator: 'assistant',
      routeType: 'direct',
      routeReason: 'social_only',
      retrievalInvoked: false,
    } as NonNullable<ChatConversationTurnDebug['route']>

    const presentation = presentActivityOutcome({ route })

    expect(presentation.title).toBe('Direct assistant reply')
    expect(presentation.facts).toContainEqual({ label: 'Activity route', value: 'Direct assistant reply' })
    expect(presentation.facts).toContainEqual({ label: 'Reason', value: 'Conversational message' })
    expect(presentation.facts).not.toContainEqual({ label: 'Document search', value: 'Not used' })
  })
})
