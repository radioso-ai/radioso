import type {
  AudiencePulseAnswerSummary,
  AudiencePulseHydratedReport,
  AudiencePulseTheme,
} from '@/lib/api-audience-pulse'
import type { SparklinePoint, StatDelta } from '@/lib/stat-tile'

/**
 * Below this many questions a rate, a comparison, a trend, or a channel flag is noise: a topic
 * row prints "X of Y" instead of a percentage and shows no comparison, trend, or flag. Quality's
 * `MIN_RATE_SAMPLE` (20) floors a tile over a day-bucketed window; a topic's share moves a point
 * with every question at that size, so Audience Pulse holds its rows to a larger sample.
 */
export const PULSE_MIN_SAMPLE = 50

/** A topic whose share grew by at least this many points reads as rising. */
const RISING_POINTS = 2

/** A channel answering this many points below the whole window gets flagged. */
const CHANNEL_FLAG_POINTS = 8

export const isAboveSampleFloor = (questionCount: number): boolean => questionCount >= PULSE_MIN_SAMPLE

const countFormat = new Intl.NumberFormat()

export const formatCount = (value: number): string => countFormat.format(value)

/** `part` as a whole percentage of `whole`; 0 when there is no whole. */
export const percentOf = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0

/** A rate where the sample carries one, the raw "X of Y" below the floor. */
export const formatRateOrCount = (part: number, whole: number): string =>
  isAboveSampleFloor(whole) ? `${percentOf(part, whole)}%` : `${formatCount(part)} of ${formatCount(whole)}`

const signed = (value: number): string => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`

/** "+3 pts", "−1 pt", "0 pts". */
export const formatPoints = (points: number): string =>
  `${signed(points)} ${Math.abs(points) === 1 ? 'pt' : 'pts'}`

// ── Answer split ────────────────────────────────────────────────────────────

export type AnswerSplitKey = 'answered' | 'noAnswer' | 'partly' | 'outside' | 'notAssessed'

export interface AnswerSplitPart {
  key: AnswerSplitKey
  label: string
  count: number
}

/**
 * How a set of questions was answered, in five parts that add up to the whole: the content gap
 * comes out of the partial, unanswered and unclear questions, since those are where the documents
 * fell short. The one rule for the whole window and for each topic.
 */
export const answerSplit = (
  answers: AudiencePulseAnswerSummary,
  contentGapEligible: number,
): AnswerSplitPart[] => [
  { key: 'answered', label: 'Answered', count: answers.answered },
  { key: 'noAnswer', label: 'No answer in your content', count: contentGapEligible },
  {
    key: 'partly',
    label: 'Partly answered or unclear',
    count: Math.max(0, answers.partial + answers.unanswered + answers.unclear - contentGapEligible),
  },
  { key: 'outside', label: 'Outside what the agent covers', count: answers.outOfScope },
  { key: 'notAssessed', label: 'Not assessed', count: answers.notAssessed },
]

// ── Tiles ───────────────────────────────────────────────────────────────────

type PulseTileId = 'conversations' | 'questions' | 'answered' | 'no_answer'

export interface PulseTile {
  id: PulseTileId
  label: string
  value: string
  subtext: string
  /** Null when there is nothing to compare against. */
  delta: StatDelta | null
  series: SparklinePoint[]
  /** A count series reads as counts, a rate series as fractions of 1. */
  seriesKind: 'count' | 'rate'
}

const DAY_MS = 86_400_000

const deltaOf = (change: number, text: string, label: string, upIsGood: boolean | null): StatDelta => {
  if (change === 0) return { text: `No change ${label}`, trend: 'flat', tone: 'neutral' }
  const tone: StatDelta['tone'] = upIsGood === null ? 'neutral' : (change > 0) === upIsGood ? 'good' : 'bad'
  return { text: `${text} ${label}`, trend: change > 0 ? 'up' : 'down', tone }
}

/** A count's change in percent of the previous window. Volume is neither good nor bad. */
const countDelta = (current: number, previous: number, label: string): StatDelta | null => {
  if (previous <= 0) return null
  const percent = Math.round((current / previous - 1) * 100)
  return deltaOf(percent, `${signed(percent)}%`, label, null)
}

/** A rate's change in percentage points. */
const rateDelta = (current: number, previous: number, label: string, upIsGood: boolean): StatDelta => {
  const points = Math.round((current - previous) * 100)
  return deltaOf(points, formatPoints(points), label, upIsGood)
}

const rateValue = (part: number, whole: number): string =>
  isAboveSampleFloor(whole) ? `${percentOf(part, whole)}%` : formatCount(part)

const dailyRate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null)

/**
 * The four headline tiles, or null for a report saved before whole-window totals existed. A
 * comparison needs both windows to clear the sample floor.
 */
export const pulseTiles = (report: AudiencePulseHydratedReport): PulseTile[] | null => {
  const totals = report.totals
  if (!totals) return null
  const days = report.dailyVolume ?? []
  const previous = report.previousPeriod ?? null
  const comparable = previous !== null
    && isAboveSampleFloor(previous.questionCount)
    && isAboveSampleFloor(totals.questionCount)
  const previousDays = previous
    ? Math.round((Date.parse(previous.period.end) - Date.parse(previous.period.start)) / DAY_MS)
    : 0
  const label = `vs previous ${previousDays} days`
  const questions = totals.questionCount
  const answered = totals.answers.answered
  const noAnswer = totals.contentGapEligibleCount
  const ofQuestions = (part: number) => `${formatCount(part)} of ${formatCount(questions)} questions`
  const perConversation = totals.conversationCount > 0 ? questions / totals.conversationCount : 0

  return [
    {
      id: 'conversations',
      label: 'Conversations',
      value: formatCount(totals.conversationCount),
      subtext: 'with at least one question',
      delta: comparable ? countDelta(totals.conversationCount, previous.conversationCount, label) : null,
      series: days.map((day) => ({ date: day.day, value: day.conversationCount })),
      seriesKind: 'count',
    },
    {
      id: 'questions',
      label: 'Questions',
      value: formatCount(questions),
      subtext: `${perConversation.toFixed(1)} per conversation`,
      delta: comparable ? countDelta(questions, previous.questionCount, label) : null,
      series: days.map((day) => ({ date: day.day, value: day.questionCount })),
      seriesKind: 'count',
    },
    {
      id: 'answered',
      label: 'Questions answered',
      value: rateValue(answered, questions),
      subtext: ofQuestions(answered),
      delta: comparable
        ? rateDelta(answered / questions, previous.answeredCount / previous.questionCount, label, true)
        : null,
      series: days.map((day) => ({ date: day.day, value: dailyRate(day.answeredCount, day.questionCount) })),
      seriesKind: 'rate',
    },
    {
      id: 'no_answer',
      label: 'No answer in your content',
      value: rateValue(noAnswer, questions),
      subtext: ofQuestions(noAnswer),
      delta: comparable
        ? rateDelta(noAnswer / questions, previous.contentGapEligibleCount / previous.questionCount, label, false)
        : null,
      series: days.map((day) => ({ date: day.day, value: dailyRate(day.contentGapEligibleCount, day.questionCount) })),
      seriesKind: 'rate',
    },
  ]
}

// ── Topics ──────────────────────────────────────────────────────────────────

export type TopicComparison =
  | { kind: 'new' }
  | { kind: 'points'; points: number }
  | { kind: 'none' }

/**
 * How a topic's share moved since the report its previous share comes from. An emerged topic is
 * new at any size, except on the first census, where every topic emerged. A topic matched to its
 * predecessor only by estimate is not proven to be the same topic, so it claims no change.
 */
export const topicComparison = (theme: AudiencePulseTheme, markEmergedAsNew: boolean): TopicComparison => {
  if (theme.transition?.kind === 'emerged' && markEmergedAsNew) return { kind: 'new' }
  if (theme.previousShare === null || theme.transition?.viaCentroidFallback) return { kind: 'none' }
  if (!isAboveSampleFloor(theme.memberCount)) return { kind: 'none' }
  return { kind: 'points', points: Math.round((theme.share - theme.previousShare) * 100) }
}

export interface TopicRow {
  theme: AudiencePulseTheme
  comparison: TopicComparison
  /** Questions with no answer in your content. */
  noAnswerCount: number
  /** Null when an older API sent no answer summary. */
  answeredCount: number | null
  inQueue: boolean
  rising: boolean
}

export type TopicFilter = 'all' | 'content' | 'new' | 'rising'

export const topicRows = (
  report: AudiencePulseHydratedReport,
  queueTopicIds: ReadonlySet<string>,
): TopicRow[] =>
  report.themes.map((theme) => {
    const comparison = topicComparison(theme, !report.isFirstCensus)
    return {
      theme,
      comparison,
      noAnswerCount: theme.grounding.contentGapEligible,
      answeredCount: theme.answers?.answered ?? null,
      inQueue: queueTopicIds.has(theme.id),
      rising: comparison.kind === 'points' && comparison.points >= RISING_POINTS,
    }
  })

const TOPIC_FILTERS: Record<TopicFilter, (row: TopicRow) => boolean> = {
  all: () => true,
  content: (row) => row.inQueue,
  new: (row) => row.comparison.kind === 'new',
  rising: (row) => row.rising,
}

export const filterTopicRows = (rows: readonly TopicRow[], filter: TopicFilter): TopicRow[] =>
  rows.filter(TOPIC_FILTERS[filter])

export const topicFilterCounts = (rows: readonly TopicRow[]): Record<TopicFilter, number> => ({
  all: rows.length,
  content: filterTopicRows(rows, 'content').length,
  new: filterTopicRows(rows, 'new').length,
  rising: filterTopicRows(rows, 'rising').length,
})

export type TopicSortKey = 'questions' | 'comparison' | 'answered' | 'noAnswer'

export interface TopicSort {
  key: TopicSortKey
  direction: 'asc' | 'desc'
}

const comparisonRank = (comparison: TopicComparison): number =>
  comparison.kind === 'new'
    ? Number.POSITIVE_INFINITY
    : comparison.kind === 'points' ? comparison.points : Number.NEGATIVE_INFINITY

const SORT_VALUE: Record<TopicSortKey, (row: TopicRow) => number> = {
  questions: (row) => row.theme.memberCount,
  comparison: (row) => comparisonRank(row.comparison),
  answered: (row) =>
    row.answeredCount === null || row.theme.memberCount === 0 ? -1 : row.answeredCount / row.theme.memberCount,
  noAnswer: (row) => row.noAnswerCount,
}

/** Sorted by the chosen column, ties broken by questions, most first. */
export const sortTopicRows = (rows: readonly TopicRow[], sort: TopicSort): TopicRow[] => {
  const value = SORT_VALUE[sort.key]
  const sign = sort.direction === 'desc' ? -1 : 1
  return [...rows].sort((left, right) => {
    const a = value(left)
    const b = value(right)
    const order = a === b ? 0 : a < b ? -1 : 1
    return order * sign || right.theme.memberCount - left.theme.memberCount
  })
}

export interface OtherTopicRow {
  questionCount: number
  answeredCount: number
  noAnswerCount: number
  /** Of the whole window, 0..1. */
  share: number
}

/** The questions no topic took, or null when the report has no totals or none were left over. */
export const otherTopicRow = (report: AudiencePulseHydratedReport): OtherTopicRow | null => {
  const totals = report.totals
  if (!totals || totals.unclassified.questionCount === 0) return null
  return {
    questionCount: totals.unclassified.questionCount,
    answeredCount: totals.unclassified.answers.answered,
    noAnswerCount: totals.unclassified.contentGapEligibleCount,
    share: totals.questionCount > 0 ? totals.unclassified.questionCount / totals.questionCount : 0,
  }
}

// ── Channels ────────────────────────────────────────────────────────────────

export interface ChannelRow {
  channel: string | null
  questionCount: number
  answeredCount: number
  answeredPercent: number
  sharePercent: number
  aboveFloor: boolean
  /** The one channel answering far enough below the whole window to call out. */
  flagged: boolean
}

/**
 * The window by channel, or null with fewer than two channels. Only the channel furthest below
 * the overall answered rate is flagged, and only when it clears the sample floor.
 */
export const channelRows = (
  report: AudiencePulseHydratedReport,
): { overallAnsweredPercent: number; rows: ChannelRow[] } | null => {
  const channels = report.channels ?? []
  if (channels.length < 2) return null
  const questions = channels.reduce((sum, row) => sum + row.questionCount, 0)
  const answered = channels.reduce((sum, row) => sum + row.answeredCount, 0)
  const overallAnsweredPercent = percentOf(answered, questions)
  const rows = channels.map((row) => ({
    channel: row.channel,
    questionCount: row.questionCount,
    answeredCount: row.answeredCount,
    answeredPercent: percentOf(row.answeredCount, row.questionCount),
    sharePercent: percentOf(row.questionCount, questions),
    aboveFloor: isAboveSampleFloor(row.questionCount),
    flagged: false,
  }))
  let flagged: ChannelRow | null = null
  for (const row of rows) {
    const shortfall = overallAnsweredPercent - row.answeredPercent
    if (row.aboveFloor && shortfall >= CHANNEL_FLAG_POINTS
      && (flagged === null || shortfall > overallAnsweredPercent - flagged.answeredPercent)) {
      flagged = row
    }
  }
  return { overallAnsweredPercent, rows: rows.map((row) => (row === flagged ? { ...row, flagged: true } : row)) }
}
