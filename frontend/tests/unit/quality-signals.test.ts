import { describe, expect, it } from 'vitest'

import type { SkillCatalogEntry } from '@/lib/api'
import {
  ACTIVE_TRIAGE_STATES,
  activeQualitySignal,
  groundingGapActions,
  SKILL_FAILURE_STATUSES,
  SLOW_RESPONSE_LATENCY_BUCKET,
  type AppliedQualityFilters,
} from '@/lib/quality-signals'

type Outcome = NonNullable<SkillCatalogEntry['outcomes']>[number]

function outcome(name: string, groundedAnswer?: boolean): Outcome {
  return {
    name,
    displayName: name,
    status: 'completed',
    ...(groundedAnswer === undefined ? {} : { groundedAnswer }),
  } as Outcome
}

function skill(name: string, outcomes: Outcome[]): SkillCatalogEntry {
  return { name, outcomes } as SkillCatalogEntry
}

describe('groundingGapActions', () => {
  it('selects only outcomes the catalog marks as not grounded', () => {
    const skills = [
      skill('retrieval.answer', [
        outcome('grounded', true),
        outcome('no_context', false),
        outcome('degraded', false),
      ]),
      skill('assistant.reply', [
        outcome('answered', true),
        outcome('unknown'), // groundedAnswer absent — not a gap
      ]),
    ]

    expect(groundingGapActions(skills)).toEqual([
      { skillName: 'retrieval.answer', outcome: 'no_context' },
      { skillName: 'retrieval.answer', outcome: 'degraded' },
    ])
  })

  it('returns an empty list when no outcome is marked ungrounded', () => {
    const skills = [skill('retrieval.answer', [outcome('grounded', true), outcome('unknown')])]
    expect(groundingGapActions(skills)).toEqual([])
  })

  it('tolerates skills without outcomes', () => {
    expect(groundingGapActions([skill('platform.noop', [])])).toEqual([])
    expect(groundingGapActions([{ name: 'platform.noop' } as SkillCatalogEntry])).toEqual([])
  })
})

describe('activeQualitySignal', () => {
  const grounding = [
    { skillName: 'retrieval.answer', outcome: 'no_context' },
    { skillName: 'retrieval.answer', outcome: 'degraded' },
  ]

  const applied = (overrides: Partial<AppliedQualityFilters>): AppliedQualityFilters => ({
    feedback: [],
    actions: [],
    statuses: [],
    triageStates: [...ACTIVE_TRIAGE_STATES],
    latency: null,
    ...overrides,
  })

  it('matches the negative-feedback preset', () => {
    expect(activeQualitySignal(applied({ feedback: ['down'] }), grounding)).toBe('negative_feedback')
  })

  it('matches the slow-responses preset', () => {
    expect(activeQualitySignal(applied({ latency: SLOW_RESPONSE_LATENCY_BUCKET }), grounding)).toBe(
      'slow_responses',
    )
  })

  it('matches the grounding-gaps preset regardless of action order', () => {
    expect(
      activeQualitySignal(
        applied({
          actions: [
            { skillName: 'retrieval.answer', outcome: 'degraded' },
            { skillName: 'retrieval.answer', outcome: 'no_context' },
          ],
        }),
        grounding,
      ),
    ).toBe('grounding_gaps')
  })

  it('matches the skill-failures preset', () => {
    expect(activeQualitySignal(applied({ statuses: [...SKILL_FAILURE_STATUSES] }), grounding)).toBe(
      'skill_failures',
    )
  })

  it('does not light a tile for thumbs-up-only feedback', () => {
    expect(activeQualitySignal(applied({ feedback: ['up'] }), grounding)).toBeNull()
  })

  it('does not light a tile for a different latency band', () => {
    expect(activeQualitySignal(applied({ latency: '2s_5s' }), grounding)).toBeNull()
  })

  it('does not light a tile for a non-failure status filter', () => {
    expect(activeQualitySignal(applied({ statuses: ['completed'] }), grounding)).toBeNull()
  })

  it('does not light a tile when filters mix multiple dimensions', () => {
    expect(activeQualitySignal(applied({ feedback: ['down'], actions: grounding }), grounding)).toBeNull()
  })

  it('does not light skill failures when a status filter is mixed with feedback', () => {
    expect(
      activeQualitySignal(applied({ feedback: ['down'], statuses: [...SKILL_FAILURE_STATUSES] }), grounding),
    ).toBeNull()
  })

  it('does not light grounding gaps for a partial action set', () => {
    expect(activeQualitySignal(applied({ actions: [grounding[0]] }), grounding)).toBeNull()
  })

  it('does not light a tile when the triage filter is missing', () => {
    expect(activeQualitySignal(applied({ feedback: ['down'], triageStates: [] }), grounding)).toBeNull()
  })

  it('does not light a tile when the triage filter includes closed states', () => {
    expect(
      activeQualitySignal(applied({ feedback: ['down'], triageStates: ['resolved'] }), grounding),
    ).toBeNull()
  })

  it('returns null when no filters are applied', () => {
    expect(activeQualitySignal(applied({ triageStates: [] }), grounding)).toBeNull()
  })
})
