import { describe, expect, it } from 'vitest'

import type { SkillCatalogEntry } from '@/lib/api'
import {
  activeQualitySignal,
  groundingGapActions,
  SLOW_RESPONSE_LATENCY_BUCKET,
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

  it('matches the negative-feedback preset', () => {
    expect(
      activeQualitySignal({ feedback: ['down'], actions: [], latency: null }, grounding),
    ).toBe('negative_feedback')
  })

  it('matches the slow-responses preset', () => {
    expect(
      activeQualitySignal(
        { feedback: [], actions: [], latency: SLOW_RESPONSE_LATENCY_BUCKET },
        grounding,
      ),
    ).toBe('slow_responses')
  })

  it('matches the grounding-gaps preset regardless of action order', () => {
    expect(
      activeQualitySignal(
        {
          feedback: [],
          actions: [
            { skillName: 'retrieval.answer', outcome: 'degraded' },
            { skillName: 'retrieval.answer', outcome: 'no_context' },
          ],
          latency: null,
        },
        grounding,
      ),
    ).toBe('grounding_gaps')
  })

  it('does not light a tile for thumbs-up-only feedback', () => {
    expect(
      activeQualitySignal({ feedback: ['up'], actions: [], latency: null }, grounding),
    ).toBeNull()
  })

  it('does not light a tile for a different latency band', () => {
    expect(
      activeQualitySignal({ feedback: [], actions: [], latency: '2s_5s' }, grounding),
    ).toBeNull()
  })

  it('does not light a tile when filters mix multiple dimensions', () => {
    expect(
      activeQualitySignal(
        { feedback: ['down'], actions: grounding, latency: null },
        grounding,
      ),
    ).toBeNull()
  })

  it('does not light grounding gaps for a partial action set', () => {
    expect(
      activeQualitySignal(
        { feedback: [], actions: [grounding[0]], latency: null },
        grounding,
      ),
    ).toBeNull()
  })

  it('returns null when no filters are applied', () => {
    expect(
      activeQualitySignal({ feedback: [], actions: [], latency: null }, grounding),
    ).toBeNull()
  })
})
