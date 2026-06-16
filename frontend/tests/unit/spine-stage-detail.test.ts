import { describe, expect, it } from 'vitest'

import { buildClarificationStageDetail, buildRoutineRunTrace } from '@/components/dashboard/spine-stage-detail'
import type { ConversationTraceStage } from '@/lib/api'

describe('buildClarificationStageDetail', () => {
  it('extracts metadata-safe clarification fields and ignores candidate payloads', () => {
    const stage: ConversationTraceStage = {
      id: 'clarification',
      kind: 'clarification',
      status: 'applied',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'asked',
        reason: 'too_close',
        margin: 0.03,
        candidates: [
          {
            id: 'hatha',
            label: 'Hatha yoga',
            confidence: 0.73,
            payload: { documentContent: 'must not render' },
          },
        ],
        chosenCandidateId: 'hatha',
        mappingOutcome: { outcome: 'chosen', candidateId: 'hatha' },
      },
    }

    expect(buildClarificationStageDetail(stage)).toEqual({
      surface: 'retrieval_sense',
      decision: 'asked',
      reason: 'too_close',
      margin: 0.03,
      candidates: [{ id: 'hatha', label: 'Hatha yoga', confidence: 0.73 }],
      chosenCandidateId: 'hatha',
      chosenCandidateLabel: 'Hatha yoga',
      alternatives: [],
      offerOutcome: undefined,
      labelFallback: false,
      mappingOutcome: '{"outcome":"chosen","candidateId":"hatha"}',
    })
  })

  it('extracts offered winner, alternatives, and accepted alternative outcome from label-only fields', () => {
    const stage: ConversationTraceStage = {
      id: 'clarification',
      kind: 'clarification',
      status: 'applied',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'offered',
        chosenCandidateId: 'hatha',
        candidates: [
          { id: 'hatha', label: 'Hatha yoga', confidence: 0.6, payload: { documentContent: 'must not render' } },
          { id: 'raja', label: 'Raja yoga', confidence: 0.58, payload: { documentContent: 'must not render' } },
        ],
        mappingOutcome: { outcome: 'chosen', candidateId: 'raja', offerOutcome: 'accepted_alternative' },
      },
    }

    expect(buildClarificationStageDetail(stage)).toMatchObject({
      decision: 'offered',
      candidates: [
        { id: 'hatha', label: 'Hatha yoga', confidence: 0.6 },
        { id: 'raja', label: 'Raja yoga', confidence: 0.58 },
      ],
      chosenCandidateId: 'hatha',
      chosenCandidateLabel: 'Hatha yoga',
      alternatives: [{ id: 'raja', label: 'Raja yoga', confidence: 0.58 }],
      offerOutcome: 'accepted_alternative',
    })
    expect(buildClarificationStageDetail(stage).mappingOutcome).not.toContain('documentContent')
  })

  it('extracts ignored offer and label fallback fields without candidate payloads', () => {
    const stage: ConversationTraceStage = {
      id: 'clarification',
      kind: 'clarification',
      status: 'applied',
      outputs: {
        surface: 'retrieval_sense',
        decision: 'auto_picked',
        reason: 'label_fallback',
        chosenCandidateId: 'hatha',
        offerOutcome: 'ignored',
        candidates: [
          {
            id: 'hatha',
            label: 'Hatha yoga',
            confidence: 0.6,
            payload: { documentContent: 'must not render' },
          },
        ],
      },
    }

    expect(buildClarificationStageDetail(stage)).toMatchObject({
      decision: 'auto_picked',
      reason: 'label_fallback',
      labelFallback: true,
      offerOutcome: 'ignored',
      candidates: [{ id: 'hatha', label: 'Hatha yoga', confidence: 0.6 }],
    })
  })
})

describe('buildRoutineRunTrace', () => {
  const routineStage = (payload: unknown): ConversationTraceStage => ({
    id: 'routine:contact',
    kind: 'routine_resume',
    status: 'applied',
    outputs: { routineId: 'contact' },
    subTrace: { namespace: 'routine', version: 1, payload },
  })

  it('parses the routine sub-trace into a step-by-step view', () => {
    const view = buildRoutineRunTrace(
      routineStage({
        routineId: 'contact',
        startStepId: 'ask_email',
        landedStepId: 'ask_message',
        capturedSlotKeys: ['email'],
        filledSlotKeys: ['email'],
        steps: [
          { stepId: 'ask_email', kind: 'chat', event: 'advanced', capturedSlotKeys: ['email'], viaSelector: true },
          { stepId: 'ask_message', kind: 'chat', event: 'rendered' },
        ],
      }),
    )

    expect(view).toEqual({
      startStepId: 'ask_email',
      landedStepId: 'ask_message',
      terminalKind: undefined,
      capturedSlotKeys: ['email'],
      filledSlotKeys: ['email'],
      steps: [
        { stepId: 'ask_email', kind: 'chat', event: 'advanced', capturedSlotKeys: ['email'], viaSelector: true },
        { stepId: 'ask_message', kind: 'chat', event: 'rendered', capturedSlotKeys: [], viaSelector: false },
      ],
    })
  })

  it('carries skill name and status for a tool step', () => {
    const view = buildRoutineRunTrace(
      routineStage({
        steps: [{ stepId: 'lookup', kind: 'skill', event: 'skill_dispatched', skillName: 'crm_lookup', skillStatus: 'ok' }],
      }),
    )
    expect(view?.steps[0]).toMatchObject({ skillName: 'crm_lookup', skillStatus: 'ok' })
  })

  it('returns undefined when the stage carries no routine sub-trace', () => {
    expect(buildRoutineRunTrace({ id: 'routine:contact', kind: 'routine_resume', status: 'applied' })).toBeUndefined()
    expect(
      buildRoutineRunTrace({
        id: 'd',
        kind: 'routine_resume',
        status: 'applied',
        subTrace: { namespace: 'retrieval', version: 1, payload: {} },
      }),
    ).toBeUndefined()
  })
})
