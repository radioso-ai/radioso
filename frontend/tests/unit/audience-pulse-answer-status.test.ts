import { describe, expect, it } from 'vitest'

import type { AudiencePulseAnswerSummary } from '@/lib/api-audience-pulse'
import { formatTopicAnswerCounts, getTopicShortfalls } from '@/lib/audience-pulse-answer-status'

const answers = (overrides: Partial<AudiencePulseAnswerSummary>): AudiencePulseAnswerSummary => ({
  answered: 0, partial: 0, unanswered: 0, unclear: 0, outOfScope: 0, notAssessed: 0,
  ...overrides,
})

describe('formatTopicAnswerCounts', () => {
  it('lists every bucket in display order with the coverage vocabulary', () => {
    expect(formatTopicAnswerCounts(answers({
      answered: 11, partial: 2, unanswered: 2, unclear: 1, outOfScope: 1, notAssessed: 3,
    }))).toBe('11 answered · 2 unanswered · 2 partly answered · 1 needs clarification · 1 out of scope · 3 not assessed')
  })

  it('omits empty buckets', () => {
    expect(formatTopicAnswerCounts(answers({ answered: 6, partial: 1, notAssessed: 2 })))
      .toBe('6 answered · 1 partly answered · 2 not assessed')
  })

  it('returns an empty line when no question was counted', () => {
    expect(formatTopicAnswerCounts(answers({}))).toBe('')
  })
})

describe('getTopicShortfalls', () => {
  it('lists unanswered before partly answered, each only when present', () => {
    expect(getTopicShortfalls(answers({ answered: 11, partial: 2, unanswered: 2 })))
      .toEqual(['2 unanswered', '2 partly answered'])
    expect(getTopicShortfalls(answers({ answered: 6, partial: 1 }))).toEqual(['1 partly answered'])
    expect(getTopicShortfalls(answers({ unanswered: 3, unclear: 1 }))).toEqual(['3 unanswered'])
  })

  it('leaves answered, clarification, out-of-scope, and unassessed questions out', () => {
    expect(getTopicShortfalls(answers({ answered: 10, unclear: 1, outOfScope: 3, notAssessed: 2 }))).toEqual([])
  })

  it('repeats the expanded counts line word for word, in the same order', () => {
    const summary = answers({ answered: 4, partial: 1, unanswered: 2, outOfScope: 2 })

    expect(formatTopicAnswerCounts(summary)).toContain(getTopicShortfalls(summary).join(' · '))
  })
})
