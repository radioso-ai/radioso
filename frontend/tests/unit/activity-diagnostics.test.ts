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
          responseLanguagePolicy: 'match_user_question',
        },
      },
    ])

    const presentation = presentRunParameters(trace)

    expect(presentation?.title).toBe('Retrieval parameters')
    expect(presentation?.facts).toContainEqual({ label: 'Query rewrite', value: 'Enabled' })
    expect(presentation?.facts).toContainEqual({ label: 'Meaning search limit', value: '12' })
    expect(presentation?.facts).toContainEqual({ label: 'Citation display', value: 'Enabled' })
  })

  const directRoute = (routeReason: string) => ({
    generator: 'assistant',
    routeType: 'direct',
    routeReason,
    retrievalInvoked: false,
  } as NonNullable<ChatConversationTurnDebug['route']>)

  it('names a conversational (social) direct reply specifically', () => {
    const presentation = presentActivityOutcome({ route: directRoute('social_only') })

    expect(presentation.title).toBe('Conversational reply')
    expect(presentation.facts).toContainEqual({ label: 'Activity route', value: 'Conversational reply' })
    expect(presentation.facts).toContainEqual({ label: 'Reason', value: 'Conversational message' })
    expect(presentation.facts).not.toContainEqual({ label: 'Document search', value: 'Not used' })
  })

  it('distinguishes an assistant-identity direct reply', () => {
    const presentation = presentActivityOutcome({ route: directRoute('assistant_identity') })
    expect(presentation.title).toBe('Answered about the assistant')
  })

  it('distinguishes a conversation-starter direct reply', () => {
    const presentation = presentActivityOutcome({ route: directRoute('conversation_start') })
    expect(presentation.title).toBe('Conversation starter')
  })

  it('reports a routine-driven reply with the routine name and progress', () => {
    const collecting = presentActivityOutcome({
      route: directRoute('social_only'),
      routine: { name: 'Book a product demo', completed: false },
    })
    expect(collecting.title).toBe('Routine reply')
    expect(collecting.summary).toContain('Book a product demo')
    expect(collecting.summary).toContain('gathering details')
    expect(collecting.facts).toContainEqual({ label: 'Activity route', value: 'Routine · Book a product demo' })
    expect(collecting.facts).toContainEqual({ label: 'State', value: 'Awaiting user reply' })

    const completed = presentActivityOutcome({
      routine: { name: 'Book a product demo', completed: true },
    })
    expect(completed.facts).toContainEqual({ label: 'State', value: 'Completed' })
    expect(completed.summary).toContain('final step')
  })

  it('calls out a clarifying question as its own outcome', () => {
    const presentation = presentActivityOutcome({
      route: directRoute('evidence_required'),
      clarificationAsked: true,
    })
    expect(presentation.title).toBe('Asked a clarifying question')
  })

  it('splits a grounded answer from a no-context refusal', () => {
    const retrievalStages = [
      {
        stageId: 'context_selection',
        kind: 'context_selection',
        label: 'Context selection',
        status: 'applied' as const,
      },
    ]
    const grounded = presentActivityOutcome({
      trace: baseTrace(retrievalStages, { candidateCounts: { semantic: 5, lexical: 2, merged: 6, final: 3 } }),
      answerOutcome: 'grounded_success',
    })
    expect(grounded.title).toBe('Answered from workspace documents')

    const refused = presentActivityOutcome({
      trace: baseTrace(retrievalStages, { candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 } }),
      answerOutcome: 'no_context_refusal',
    })
    expect(refused.title).toBe('No answer in workspace documents')
    expect(refused.tone).toBe('warning')
  })
})
