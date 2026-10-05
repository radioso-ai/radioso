import { describe, expect, it } from 'vitest'

import type { AudiencePulseTheme, AudiencePulseThemeEvidence } from '@/lib/api-audience-pulse'
import {
  formatTopicAnswerCounts,
  getTopicExamples,
  getTopicShortfalls,
} from '@/lib/audience-pulse-answer-status'

const noGrounding: AudiencePulseTheme['grounding'] = {
  grounded: 0, degraded: 0, noSupport: 0, unknown: 0, contentGapEligible: 0,
}

const coverage = (
  overrides: Partial<NonNullable<AudiencePulseTheme['coverage']>>,
): NonNullable<AudiencePulseTheme['coverage']> => ({
  answered: 0, partial: 0, unanswered: 0, unclear: 0, outOfScope: 0, unassessed: 0, legacy: 0, reasons: {},
  ...overrides,
})

const evidence = (
  reference: string,
  answerCoverage?: AudiencePulseThemeEvidence['answerCoverage'],
): AudiencePulseThemeEvidence => ({
  reference,
  conversationId: `conversation-${reference}`,
  messageId: `message-${reference}`,
  question: `Question ${reference}?`,
  occurrenceCount: 1,
  ...(answerCoverage ? { answerCoverage } : {}),
})

const assessed = (verdict: 'answered' | 'partial' | 'unanswered' | 'unclear') =>
  ({ availability: 'assessed', coverage: verdict }) as const

describe('formatTopicAnswerCounts', () => {
  it('reads semantic coverage in display order and omits empty buckets', () => {
    expect(formatTopicAnswerCounts({
      grounding: { ...noGrounding, grounded: 99 },
      coverage: coverage({ answered: 6, partial: 1, unassessed: 2 }),
    })).toBe('6 answered · 1 partly answered · 2 not assessed')
  })

  it('names every coverage bucket with the turn inspector labels', () => {
    expect(formatTopicAnswerCounts({
      grounding: noGrounding,
      coverage: coverage({ answered: 2, partial: 4, unanswered: 3, unclear: 1, outOfScope: 2, unassessed: 2, legacy: 2 }),
    })).toBe('2 answered · 4 partly answered · 3 unanswered · 1 needs clarification · 2 out of scope · 4 not assessed')
  })

  it('folds records from before answers were checked into not assessed', () => {
    expect(formatTopicAnswerCounts({
      grounding: noGrounding,
      coverage: coverage({ answered: 1, legacy: 3 }),
    })).toBe('1 answered · 3 not assessed')
  })

  it('falls back to grounding for a report saved without semantic coverage', () => {
    expect(formatTopicAnswerCounts({
      grounding: { grounded: 5, degraded: 2, noSupport: 1, unknown: 4, contentGapEligible: 3 },
    })).toBe('5 answered · 2 partly answered · 1 unanswered · 4 not assessed')
  })

  it('returns an empty line when no question was counted', () => {
    expect(formatTopicAnswerCounts({ grounding: noGrounding, coverage: coverage({}) })).toBe('')
    expect(formatTopicAnswerCounts({ grounding: noGrounding })).toBe('')
  })

  it('treats a null coverage summary like an absent one', () => {
    const grounding = { grounded: 5, degraded: 0, noSupport: 1, unknown: 0, contentGapEligible: 1 }
    const nullCoverage = { grounding, coverage: null } as unknown as Pick<AudiencePulseTheme, 'coverage' | 'grounding'>

    expect(formatTopicAnswerCounts(nullCoverage)).toBe('5 answered · 1 unanswered')
    expect(getTopicShortfalls(nullCoverage)).toEqual(['1 unanswered'])
  })
})

describe('getTopicShortfalls', () => {
  it('lists unanswered before partly answered, each only when present', () => {
    expect(getTopicShortfalls({
      grounding: noGrounding,
      coverage: coverage({ answered: 11, partial: 2, unanswered: 2, unassessed: 3 }),
    })).toEqual(['2 unanswered', '2 partly answered'])
    expect(getTopicShortfalls({
      grounding: noGrounding,
      coverage: coverage({ answered: 6, partial: 1, unassessed: 2 }),
    })).toEqual(['1 partly answered'])
    expect(getTopicShortfalls({
      grounding: noGrounding,
      coverage: coverage({ unanswered: 3, unclear: 1 }),
    })).toEqual(['3 unanswered'])
  })

  it('is empty for a topic the agent answered in full', () => {
    expect(getTopicShortfalls({
      grounding: noGrounding,
      coverage: coverage({ answered: 10, unclear: 1, unassessed: 2, legacy: 1 }),
    })).toEqual([])
  })

  it('leaves out-of-scope declines out of the shortfalls', () => {
    expect(getTopicShortfalls({
      grounding: noGrounding,
      coverage: coverage({ answered: 4, unanswered: 1, outOfScope: 3 }),
    })).toEqual(['1 unanswered'])
  })

  it('falls back to grounding for a report saved without semantic coverage', () => {
    expect(getTopicShortfalls({
      grounding: { grounded: 5, degraded: 2, noSupport: 1, unknown: 4, contentGapEligible: 3 },
    })).toEqual(['1 unanswered', '2 partly answered'])
  })

  it('repeats the expanded counts line word for word, whatever the content-gap count says', () => {
    const theme = {
      // The content-gap count only includes shortfalls for lack of material, so it reads 1 here.
      grounding: { ...noGrounding, contentGapEligible: 1 },
      coverage: coverage({ answered: 4, partial: 1, unanswered: 2 }),
    }

    const shortfalls = getTopicShortfalls(theme)
    expect(shortfalls).toEqual(['2 unanswered', '1 partly answered'])
    const expandedBuckets = formatTopicAnswerCounts(theme).split(' · ')
    for (const shortfall of shortfalls) expect(expandedBuckets).toContain(shortfall)
  })
})

describe('getTopicExamples', () => {
  it('labels each example from its recorded assessment', () => {
    const examples = getTopicExamples({
      coverage: coverage({ answered: 1 }),
      evidence: [
        evidence('answered', assessed('answered')),
        evidence('clarify', assessed('unclear')),
        evidence('failed', { availability: 'failed' }),
        evidence('legacy'),
      ],
    })

    expect(examples.map(({ evidence: item, label }) => [item.reference, label])).toEqual([
      ['answered', 'Answered'],
      ['clarify', 'Needs clarification'],
      ['failed', 'Not assessed'],
      ['legacy', 'Not assessed'],
    ])
  })

  it('labels a scope-boundary decline as out of scope and does not rank it as a shortfall', () => {
    const examples = getTopicExamples({
      coverage: coverage({ answered: 1, unanswered: 1, outOfScope: 2 }),
      evidence: [
        evidence('declined', { availability: 'assessed', coverage: 'unanswered', reason: 'intentional_scope_boundary' }),
        evidence('answered', assessed('answered')),
        evidence('partly-declined', { availability: 'assessed', coverage: 'partial', reason: 'intentional_scope_boundary' }),
        evidence('missing', { availability: 'assessed', coverage: 'unanswered', reason: 'insufficient_evidence' }),
      ],
    })

    expect(examples.map(({ evidence: item, label }) => [item.reference, label])).toEqual([
      ['missing', 'Unanswered'],
      ['declined', 'Out of scope'],
      ['answered', 'Answered'],
      ['partly-declined', 'Out of scope'],
    ])
  })

  it('puts unanswered and partly answered examples first and keeps the rest in report order', () => {
    const examples = getTopicExamples({
      coverage: coverage({ answered: 2 }),
      evidence: [
        evidence('a', assessed('answered')),
        evidence('b'),
        evidence('c', assessed('partial')),
        evidence('d', assessed('answered')),
        evidence('e', assessed('unanswered')),
      ],
    })

    expect(examples.map(({ evidence: item, label }) => [item.reference, label])).toEqual([
      ['e', 'Unanswered'],
      ['c', 'Partly answered'],
      ['a', 'Answered'],
      ['b', 'Not assessed'],
      ['d', 'Answered'],
    ])
  })

  it('leaves examples unlabelled when the report predates answer checks', () => {
    const examples = getTopicExamples({ evidence: [evidence('a'), evidence('b')] })
    const nullCoverageExamples = getTopicExamples(
      { coverage: null, evidence: [evidence('a')] } as unknown as Pick<AudiencePulseTheme, 'coverage' | 'evidence'>,
    )

    expect(examples.map(({ evidence: item, label }) => [item.reference, label])).toEqual([
      ['a', null],
      ['b', null],
    ])
    expect(nullCoverageExamples.map(({ label }) => label)).toEqual([null])
  })
})
