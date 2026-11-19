import {
  answerStatus,
  summarizeAnswerStatuses,
  type AudiencePulseAnswerStatus,
  type AudiencePulseAnswerStatusInput,
  type AudiencePulseAnswerSummary,
} from "./answerStatus.js";
import { audiencePulseUtcDay } from "../../../shared/domain/audiencePulseUtcDay.js";

/*
 * Whole-window counts a report shows beside its topics. Every count reads `answerStatus` and the
 * content-gap flag of each question, the same per-question rule a topic's own counts use, so the
 * figures add up across topics, days and channels.
 */

/** What a period count reads of one question. */
interface AudiencePulseCountedQuestion extends AudiencePulseAnswerStatusInput {
  reference: { conversationId: string };
}

/** One question of the report's population, with the day and channel it is counted under. */
interface AudiencePulsePopulationQuestion extends AudiencePulseCountedQuestion {
  id: string;
  /** The UTC calendar day the question was asked, `YYYY-MM-DD`. */
  day: string;
  channel: string | null;
}

interface AudiencePulsePeriodTotals {
  questionCount: number;
  /** Distinct conversations with at least one counted question. */
  conversationCount: number;
  /** Questions whose `answerStatus` is `answered`. */
  answeredCount: number;
  /** Questions the content-gap rule flags: no answer in the workspace's content. */
  contentGapEligibleCount: number;
}

/** A period's totals, for the window immediately before the report's own. */
export interface AudiencePulsePreviousPeriod extends AudiencePulsePeriodTotals {
  period: { start: string; end: string };
}

/** A set of questions counted by answer status. */
interface AudiencePulseAnswerTally {
  questionCount: number;
  answers: AudiencePulseAnswerSummary;
  contentGapEligibleCount: number;
}

export interface AudiencePulseReportTotals extends AudiencePulseAnswerTally {
  conversationCount: number;
  /** The questions no topic claimed. With every topic's own counts, these make up the totals. */
  unclassified: AudiencePulseAnswerTally;
}

export interface AudiencePulseDailyVolume extends AudiencePulsePeriodTotals {
  /** A UTC calendar day, `YYYY-MM-DD`. */
  day: string;
}

export interface AudiencePulseChannelVolume {
  /** The conversation's source channel; null for a conversation that records none. */
  channel: string | null;
  questionCount: number;
  answeredCount: number;
  contentGapEligibleCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Classified<Question extends AudiencePulseCountedQuestion> {
  question: Question;
  status: AudiencePulseAnswerStatus;
}

const classify = <Question extends AudiencePulseCountedQuestion>(
  questions: readonly Question[],
): Array<Classified<Question>> => questions.map((question) => ({ question, status: answerStatus(question) }));

const periodTotalsOf = (items: ReadonlyArray<Classified<AudiencePulseCountedQuestion>>): AudiencePulsePeriodTotals => {
  const conversationIds = new Set<string>();
  let answeredCount = 0;
  let contentGapEligibleCount = 0;
  for (const { question, status } of items) {
    conversationIds.add(question.reference.conversationId);
    if (status === "answered") answeredCount += 1;
    if (question.contentGapEligible) contentGapEligibleCount += 1;
  }
  return { questionCount: items.length, conversationCount: conversationIds.size, answeredCount, contentGapEligibleCount };
};

const tallyOf = (items: ReadonlyArray<Classified<AudiencePulseCountedQuestion>>): AudiencePulseAnswerTally => ({
  questionCount: items.length,
  answers: summarizeAnswerStatuses(items.map(({ status }) => status)),
  contentGapEligibleCount: items.filter(({ question }) => question.contentGapEligible).length,
});

const groupBy = <Item, Key>(items: readonly Item[], keyOf: (item: Item) => Key): Map<Key, Item[]> => {
  const groups = new Map<Key, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
};

/** Every UTC day touching `[start, end)`, ascending. */
const utcDaysOf = (period: { start: Date; end: Date }): string[] => {
  const days: string[] = [];
  if (period.end <= period.start) return days;
  const last = audiencePulseUtcDay(new Date(period.end.getTime() - 1));
  const cursor = new Date(`${audiencePulseUtcDay(period.start)}T00:00:00.000Z`);
  for (let day = audiencePulseUtcDay(cursor); day <= last; day = audiencePulseUtcDay(cursor)) {
    days.push(day);
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  return days;
};

const compareChannels = (a: AudiencePulseChannelVolume, b: AudiencePulseChannelVolume): number => {
  if (b.questionCount !== a.questionCount) return b.questionCount - a.questionCount;
  if (a.channel === b.channel) return 0;
  if (a.channel === null) return 1;
  if (b.channel === null) return -1;
  return a.channel.localeCompare(b.channel);
};

export const summarizeAudiencePulsePeriod = (
  questions: readonly AudiencePulseCountedQuestion[],
): AudiencePulsePeriodTotals => periodTotalsOf(classify(questions));

/**
 * The earliest moment a workspace's history is whole: when it was created, or, with conversation
 * retention set, `retentionDays` before now, since the sweep is removing anything older. A window
 * that starts earlier would count only what survived, and read as growth that never happened.
 */
export const audiencePulseVisibleFrom = (input: {
  workspaceCreatedAt: Date;
  conversationRetentionDays: number | null;
  now: Date;
}): Date => {
  if (input.conversationRetentionDays === null) return input.workspaceCreatedAt;
  const retainedFrom = new Date(input.now.getTime() - input.conversationRetentionDays * DAY_MS);
  return retainedFrom > input.workspaceCreatedAt ? retainedFrom : input.workspaceCreatedAt;
};

/** A previous window with no eligible question has nothing to compare against. */
export const audiencePulsePreviousPeriod = (input: {
  period: { start: Date; end: Date };
  totals: AudiencePulsePeriodTotals;
}): AudiencePulsePreviousPeriod | null => input.totals.questionCount === 0 ? null : {
  period: { start: input.period.start.toISOString(), end: input.period.end.toISOString() },
  ...input.totals,
};

/**
 * The report's whole-window counts: totals with the unclassified remainder, one entry per UTC day
 * the period touches (zero-filled), and one per channel, the largest first.
 */
export const summarizeAudiencePulsePopulation = (input: {
  period: { start: Date; end: Date };
  population: readonly AudiencePulsePopulationQuestion[];
  /** The questions some topic claimed. */
  classifiedIds: ReadonlySet<string>;
}): {
  totals: AudiencePulseReportTotals;
  dailyVolume: AudiencePulseDailyVolume[];
  channels: AudiencePulseChannelVolume[];
} => {
  const classified = classify(input.population);
  const totals: AudiencePulseReportTotals = {
    ...tallyOf(classified),
    conversationCount: periodTotalsOf(classified).conversationCount,
    unclassified: tallyOf(classified.filter(({ question }) => !input.classifiedIds.has(question.id))),
  };

  const byDay = groupBy(classified, ({ question }) => question.day);
  const dailyVolume = utcDaysOf(input.period).map((day) => ({ day, ...periodTotalsOf(byDay.get(day) ?? []) }));

  const channels = [...groupBy(classified, ({ question }) => question.channel)]
    .map(([channel, items]): AudiencePulseChannelVolume => {
      const { questionCount, answeredCount, contentGapEligibleCount } = periodTotalsOf(items);
      return { channel, questionCount, answeredCount, contentGapEligibleCount };
    })
    .sort(compareChannels);

  return { totals, dailyVolume, channels };
};
