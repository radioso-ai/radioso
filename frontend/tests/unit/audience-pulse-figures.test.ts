import { describe, expect, it } from 'vitest'

import type {
  AudiencePulseAnswerSummary,
  AudiencePulseHydratedReport,
  AudiencePulseTheme,
} from '@/lib/api-audience-pulse'
import {
  answerSplit,
  channelRows,
  filterTopicRows,
  formatRateOrCount,
  isAboveSampleFloor,
  otherTopicRow,
  PULSE_MIN_SAMPLE,
  pulseTiles,
  sortTopicRows,
  topicComparison,
  topicFilterCounts,
  topicRows,
} from '@/lib/audience-pulse-figures'

const answers = (overrides: Partial<AudiencePulseAnswerSummary> = {}): AudiencePulseAnswerSummary => ({
  answered: 0,
  partial: 0,
  unanswered: 0,
  unclear: 0,
  outOfScope: 0,
  notAssessed: 0,
  ...overrides,
})

const theme = (overrides: Partial<AudiencePulseTheme> = {}): AudiencePulseTheme => ({
  id: 'topic-1',
  title: 'Refund timing',
  description: 'When refunds arrive.',
  memberCount: 100,
  previousMemberCount: 90,
  previousShare: 0.2,
  transition: { kind: 'survived', parentTopicIds: ['topic-1'], viaCentroidFallback: false },
  share: 0.25,
  distinctQuestionCount: 40,
  weeklyPulse: [],
  grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 0, contentGapEligible: 10 },
  answers: answers({ answered: 70, partial: 10, unanswered: 10, unclear: 5, outOfScope: 3, notAssessed: 2 }),
  evidence: [],
  ...overrides,
})

const report = (overrides: Partial<AudiencePulseHydratedReport> = {}): AudiencePulseHydratedReport => ({
  period: { start: '2026-10-20T00:00:00.000Z', end: '2026-11-19T00:00:00.000Z' },
  generatedAt: '2026-11-19T06:00:00.000Z',
  isFirstCensus: false,
  narrativeGeneratedAt: '2026-11-19T06:00:00.000Z',
  narrativeReuseCount: 0,
  coverage: { populationSize: 400, sampleSize: 400, sampled: false, facetReadyQuestionCount: 400 },
  weeklyVolume: [],
  dissolvedTopics: [],
  themes: [theme()],
  contentGaps: [],
  recommendations: [],
  caveats: [],
  unclassifiedQuestionCount: 0,
  ...overrides,
})

const totals = (overrides: Partial<NonNullable<AudiencePulseHydratedReport['totals']>> = {}) => ({
  questionCount: 400,
  conversationCount: 160,
  answers: answers({ answered: 284, partial: 40, unanswered: 40, unclear: 8, outOfScope: 20, notAssessed: 8 }),
  contentGapEligibleCount: 36,
  unclassified: { questionCount: 20, answers: answers({ answered: 12, unanswered: 8 }), contentGapEligibleCount: 4 },
  ...overrides,
})

describe('answerSplit', () => {
  it('takes the content gap out of the partial, unanswered and unclear questions', () => {
    const split = answerSplit(
      answers({ answered: 70, partial: 10, unanswered: 10, unclear: 5, outOfScope: 3, notAssessed: 2 }),
      12,
    )

    expect(split.map((part) => [part.key, part.count])).toEqual([
      ['answered', 70],
      ['noAnswer', 12],
      ['partly', 13],
      ['outside', 3],
      ['notAssessed', 2],
    ])
    expect(split.reduce((sum, part) => sum + part.count, 0)).toBe(100)
  })

  it('never reports a negative partly-answered count', () => {
    const split = answerSplit(answers({ answered: 5, unanswered: 2 }), 4)

    expect(split.find((part) => part.key === 'partly')?.count).toBe(0)
    expect(split.find((part) => part.key === 'noAnswer')?.count).toBe(4)
  })
})

describe('sample floor', () => {
  it('reports a rate at the floor and the raw count below it', () => {
    expect(isAboveSampleFloor(PULSE_MIN_SAMPLE)).toBe(true)
    expect(isAboveSampleFloor(PULSE_MIN_SAMPLE - 1)).toBe(false)
    expect(formatRateOrCount(45, 50)).toBe('90%')
    expect(formatRateOrCount(32, 38)).toBe('32 of 38')
  })
})

describe('pulseTiles', () => {
  it('is absent for a report saved before whole-window totals existed', () => {
    expect(pulseTiles(report())).toBeNull()
  })

  it('compares counts in percent with a neutral tone and rates in points by direction', () => {
    const tiles = pulseTiles(report({
      totals: totals(),
      previousPeriod: {
        period: { start: '2026-09-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
        questionCount: 320,
        conversationCount: 160,
        answeredCount: 208,
        contentGapEligibleCount: 32,
      },
    }))

    expect(tiles?.map((tile) => [tile.id, tile.value, tile.delta])).toEqual([
      ['conversations', '160', { text: 'No change vs previous 30 days', trend: 'flat', tone: 'neutral' }],
      ['questions', '400', { text: '+25% vs previous 30 days', trend: 'up', tone: 'neutral' }],
      ['answered', '71%', { text: '+6 pts vs previous 30 days', trend: 'up', tone: 'good' }],
      ['no_answer', '9%', { text: '−1 pt vs previous 30 days', trend: 'down', tone: 'good' }],
    ])
    expect(tiles?.[1].subtext).toBe('2.5 per conversation')
    expect(tiles?.[2].subtext).toBe('284 of 400 questions')
  })

  it('marks a falling answered rate as bad and a rising no-answer rate as bad', () => {
    const tiles = pulseTiles(report({
      totals: totals(),
      previousPeriod: {
        period: { start: '2026-09-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
        questionCount: 400,
        conversationCount: 200,
        answeredCount: 320,
        contentGapEligibleCount: 12,
      },
    }))

    expect(tiles?.[0].delta).toMatchObject({ text: '−20% vs previous 30 days', trend: 'down', tone: 'neutral' })
    expect(tiles?.[2].delta).toMatchObject({ trend: 'down', tone: 'bad' })
    expect(tiles?.[3].delta).toMatchObject({ trend: 'up', tone: 'bad' })
  })

  it('has nothing to compare without a previous period or with too few questions in either window', () => {
    expect(pulseTiles(report({ totals: totals(), previousPeriod: null }))?.every((tile) => tile.delta === null)).toBe(true)
    const thinPrevious = pulseTiles(report({
      totals: totals(),
      previousPeriod: {
        period: { start: '2026-09-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
        questionCount: PULSE_MIN_SAMPLE - 1,
        conversationCount: 20,
        answeredCount: 30,
        contentGapEligibleCount: 2,
      },
    }))
    expect(thinPrevious?.every((tile) => tile.delta === null)).toBe(true)
  })

  it('draws only the whole UTC days of a window that starts and ends mid-day', () => {
    const day = (date: string) => ({ day: date, questionCount: 4, conversationCount: 2, answeredCount: 3, contentGapEligibleCount: 1 })
    const midDay = pulseTiles(report({
      period: { start: '2026-10-20T06:00:00.000Z', end: '2026-10-23T06:00:00.000Z' },
      totals: totals(),
      dailyVolume: [day('2026-10-20'), day('2026-10-21'), day('2026-10-22'), day('2026-10-23')],
    }))
    const midnight = pulseTiles(report({
      period: { start: '2026-10-20T00:00:00.000Z', end: '2026-10-23T00:00:00.000Z' },
      totals: totals(),
      dailyVolume: [day('2026-10-20'), day('2026-10-21'), day('2026-10-22')],
    }))

    expect(midDay?.[1].series.map((point) => point.date)).toEqual(['2026-10-21', '2026-10-22'])
    expect(midnight?.[1].series.map((point) => point.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22'])
  })

  it('draws daily rates, leaving a day without questions undefined', () => {
    const tiles = pulseTiles(report({
      totals: totals(),
      dailyVolume: [
        { day: '2026-10-20', questionCount: 4, conversationCount: 2, answeredCount: 3, contentGapEligibleCount: 1 },
        { day: '2026-10-21', questionCount: 0, conversationCount: 0, answeredCount: 0, contentGapEligibleCount: 0 },
      ],
    }))

    expect(tiles?.[0].series).toEqual([{ date: '2026-10-20', value: 2 }, { date: '2026-10-21', value: 0 }])
    expect(tiles?.[2].series).toEqual([{ date: '2026-10-20', value: 0.75 }, { date: '2026-10-21', value: null }])
    expect(tiles?.[3].series).toEqual([{ date: '2026-10-20', value: 0.25 }, { date: '2026-10-21', value: null }])
  })
})

describe('topic rows', () => {
  it('compares share in points for a topic seen before and above the floor', () => {
    expect(topicComparison(theme({ share: 0.25, previousShare: 0.2 }), true)).toEqual({ kind: 'points', points: 5 })
    expect(topicComparison(theme({ share: 0.2, previousShare: 0.2 }), true)).toEqual({ kind: 'points', points: 0 })
  })

  it('calls an emerged topic new, whatever its size, but not on the first census', () => {
    const emerged = theme({
      memberCount: 12,
      previousShare: null,
      transition: { kind: 'emerged', parentTopicIds: [], viaCentroidFallback: false },
    })

    expect(topicComparison(emerged, true)).toEqual({ kind: 'new' })
    expect(topicComparison(emerged, false)).toEqual({ kind: 'none' })
  })

  it('has no comparison without a previous share, under the floor, or for an estimated match', () => {
    expect(topicComparison(theme({ previousShare: null }), true)).toEqual({ kind: 'none' })
    expect(topicComparison(theme({
      transition: { kind: 'survived', parentTopicIds: ['topic-0'], viaCentroidFallback: true },
    }), true)).toEqual({ kind: 'none' })
    expect(topicComparison(theme({ memberCount: PULSE_MIN_SAMPLE - 1 }), true)).toEqual({ kind: 'none' })
  })

  it('counts and filters new, rising and content-to-write topics', () => {
    const rows = topicRows(report({
      themes: [
        theme({ id: 'rising', share: 0.3, previousShare: 0.27 }),
        theme({ id: 'flat', share: 0.2, previousShare: 0.19 }),
        theme({ id: 'small-rising', memberCount: 20, share: 0.3, previousShare: 0.1 }),
        theme({
          id: 'new',
          previousShare: null,
          transition: { kind: 'emerged', parentTopicIds: [], viaCentroidFallback: false },
        }),
      ],
    }), new Set(['flat', 'new']))

    expect(topicFilterCounts(rows)).toEqual({ all: 4, content: 2, new: 1, rising: 1 })
    expect(filterTopicRows(rows, 'rising').map((row) => row.theme.id)).toEqual(['rising'])
    expect(filterTopicRows(rows, 'content').map((row) => row.theme.id)).toEqual(['flat', 'new'])
    expect(filterTopicRows(rows, 'new').map((row) => row.theme.id)).toEqual(['new'])
  })

  it('reads the no-answer count from the topic grounding and leaves answered empty for an older API', () => {
    const [row] = topicRows(report({ themes: [theme({ answers: null })] }), new Set())

    expect(row.noAnswerCount).toBe(10)
    expect(row.answeredCount).toBeNull()
  })

  it('sorts by any column and breaks ties by questions', () => {
    const rows = topicRows(report({
      themes: [
        theme({ id: 'a', memberCount: 100, share: 0.3, previousShare: 0.31 }),
        theme({ id: 'b', memberCount: 200, share: 0.3, previousShare: 0.2 }),
        theme({
          id: 'c',
          memberCount: 60,
          previousShare: null,
          transition: { kind: 'emerged', parentTopicIds: [], viaCentroidFallback: false },
        }),
        theme({ id: 'd', memberCount: 80, previousShare: null }),
      ],
    }), new Set())

    expect(sortTopicRows(rows, { key: 'questions', direction: 'desc' }).map((row) => row.theme.id)).toEqual(['b', 'a', 'd', 'c'])
    expect(sortTopicRows(rows, { key: 'comparison', direction: 'desc' }).map((row) => row.theme.id)).toEqual(['c', 'b', 'a', 'd'])
    expect(sortTopicRows(rows, { key: 'comparison', direction: 'asc' }).map((row) => row.theme.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('builds the Other row from the unclassified questions', () => {
    expect(otherTopicRow(report())).toBeNull()
    expect(otherTopicRow(report({ totals: totals() }))).toEqual({
      questionCount: 20,
      answeredCount: 12,
      noAnswerCount: 4,
      share: 0.05,
    })
  })
})

describe('channelRows', () => {
  const channels = [
    { channel: 'website_embed', questionCount: 200, answeredCount: 150, contentGapEligibleCount: 10 },
    { channel: 'voice', questionCount: 100, answeredCount: 60, contentGapEligibleCount: 10 },
    { channel: 'slack', questionCount: 80, answeredCount: 40, contentGapEligibleCount: 10 },
    { channel: null, questionCount: 20, answeredCount: 2, contentGapEligibleCount: 1 },
  ]

  it('is hidden with fewer than two channels', () => {
    expect(channelRows(report())).toBeNull()
    expect(channelRows(report({ channels: channels.slice(0, 1) }))).toBeNull()
  })

  it('flags only the channel furthest below overall that clears the floor', () => {
    const result = channelRows(report({ channels }))

    // 252 of 400 answered overall.
    expect(result?.overallAnsweredPercent).toBe(63)
    expect(result?.rows.map((row) => [row.channel, row.flagged])).toEqual([
      ['website_embed', false],
      ['voice', false],
      ['slack', true],
      [null, false],
    ])
    expect(result?.rows.map((row) => row.sharePercent)).toEqual([50, 25, 20, 5])
  })

  it('flags nothing when no channel is eight points below overall', () => {
    const even = channels.map((row) => ({ ...row, answeredCount: Math.round(row.questionCount * 0.6) }))

    expect(channelRows(report({ channels: even }))?.rows.some((row) => row.flagged)).toBe(false)
  })
})
