import { describe, expect, it } from "vitest";

import { audiencePulseUtcDay } from "../../../src/shared/domain/audiencePulseUtcDay.js";
import {
  summarizeAudiencePulsePeriod,
  summarizeAudiencePulsePopulation,
} from "../../../src/modules/audiencePulse/domain/periodTotals.js";
import {
  buildAudiencePulseCensusReport,
  buildAudiencePulseComputingReport,
  type AudiencePulseEvidence,
} from "../../../src/modules/audiencePulse/domain/report.js";
import type { AudiencePulseAnswerSummary } from "../../../src/modules/audiencePulse/domain/answerStatus.js";

const period = {
  start: new Date("2026-07-01T12:00:00.000Z"),
  end: new Date("2026-07-04T12:00:00.000Z"),
};

const answered = {
  answerCoverage: {
    availability: "assessed",
    coverage: "answered",
    reason: "sufficient_evidence",
    schemaVersion: 1,
    producer: "answer_head",
  },
  legacyCoverage: false,
} satisfies Partial<AudiencePulseEvidence>;

const outOfScope = {
  answerCoverage: {
    availability: "assessed",
    coverage: "unanswered",
    reason: "intentional_scope_boundary",
    schemaVersion: 1,
    producer: "answer_head",
  },
  legacyCoverage: false,
} satisfies Partial<AudiencePulseEvidence>;

const noAnswerInContent = {
  answerCoverage: {
    availability: "assessed",
    coverage: "unanswered",
    reason: "insufficient_evidence",
    schemaVersion: 1,
    producer: "answer_head",
  },
  legacyCoverage: false,
  contentGapEligible: true,
} satisfies Partial<AudiencePulseEvidence>;

const question = (index: number, overrides: Partial<AudiencePulseEvidence> = {}): AudiencePulseEvidence => ({
  id: `evidence-${index}`,
  reference: { messageId: `message-${index}`, conversationId: `conversation-${index}` },
  question: `Question ${index}`,
  weekStart: "2026-06-29T00:00:00.000Z",
  day: "2026-07-01",
  channel: null,
  grounding: "unknown",
  legacyCoverage: true,
  contentGapEligible: false,
  ...overrides,
});

/** Nine questions over three conversations, three days, and three channels, every status represented. */
const population = (): AudiencePulseEvidence[] => [
  question(1, { ...answered, reference: { messageId: "m-1", conversationId: "c-1" }, day: "2026-07-01", channel: "web" }),
  question(2, { ...answered, reference: { messageId: "m-2", conversationId: "c-1" }, day: "2026-07-01", channel: "web" }),
  question(3, { ...noAnswerInContent, reference: { messageId: "m-3", conversationId: "c-2" }, day: "2026-07-01", channel: "web" }),
  question(4, { ...noAnswerInContent, reference: { messageId: "m-4", conversationId: "c-2" }, day: "2026-07-03", channel: "email" }),
  question(5, { ...outOfScope, reference: { messageId: "m-5", conversationId: "c-3" }, day: "2026-07-03", channel: "email" }),
  question(6, { grounding: "grounded", reference: { messageId: "m-6", conversationId: "c-3" }, day: "2026-07-03", channel: null }),
  question(7, {
    grounding: "degraded",
    contentGapEligible: true,
    reference: { messageId: "m-7", conversationId: "c-3" },
    day: "2026-07-04",
    channel: "web",
  }),
  question(8, { legacyCoverage: false, reference: { messageId: "m-8", conversationId: "c-3" }, day: "2026-07-04", channel: "web" }),
  question(9, {
    answerCoverage: {
      availability: "assessed",
      coverage: "unclear",
      reason: "ambiguous_request",
      schemaVersion: 1,
      producer: "answer_head",
    },
    legacyCoverage: false,
    reference: { messageId: "m-9", conversationId: "c-3" },
    day: "2026-07-04",
    channel: "email",
  }),
];

const sumAnswers = (summaries: AudiencePulseAnswerSummary[]): AudiencePulseAnswerSummary =>
  summaries.reduce((total, summary) => ({
    answered: total.answered + summary.answered,
    partial: total.partial + summary.partial,
    unanswered: total.unanswered + summary.unanswered,
    unclear: total.unclear + summary.unclear,
    outOfScope: total.outOfScope + summary.outOfScope,
    notAssessed: total.notAssessed + summary.notAssessed,
  }), { answered: 0, partial: 0, unanswered: 0, unclear: 0, outOfScope: 0, notAssessed: 0 });

const answerTotal = (summary: AudiencePulseAnswerSummary): number =>
  summary.answered + summary.partial + summary.unanswered + summary.unclear + summary.outOfScope + summary.notAssessed;

describe("audiencePulseUtcDay", () => {
  it("names the UTC calendar day, whatever the hour", () => {
    expect(audiencePulseUtcDay(new Date("2026-07-01T00:00:00.000Z"))).toBe("2026-07-01");
    expect(audiencePulseUtcDay(new Date("2026-07-01T23:59:59.999Z"))).toBe("2026-07-01");
    expect(audiencePulseUtcDay(new Date("2026-07-01T23:30:00.000-02:00"))).toBe("2026-07-02");
  });
});

describe("summarizeAudiencePulsePeriod", () => {
  it("counts questions, distinct conversations, answered questions and questions with no answer in the content", () => {
    expect(summarizeAudiencePulsePeriod(population())).toEqual({
      questionCount: 9,
      conversationCount: 3,
      // Questions 1, 2 (assessed answered) and 6 (legacy grounded) are answered.
      answeredCount: 3,
      // Questions 3, 4 (assessed, insufficient evidence) and 7 (legacy degraded retrieval).
      contentGapEligibleCount: 3,
    });
  });

  it("counts nothing for an empty window", () => {
    expect(summarizeAudiencePulsePeriod([])).toEqual({
      questionCount: 0,
      conversationCount: 0,
      answeredCount: 0,
      contentGapEligibleCount: 0,
    });
  });
});

describe("summarizeAudiencePulsePopulation", () => {
  it("totals every question by its answer status, and splits out the questions no topic claimed", () => {
    const { totals } = summarizeAudiencePulsePopulation({
      period,
      population: population(),
      classifiedIds: new Set(["evidence-1", "evidence-2", "evidence-3", "evidence-4"]),
    });

    expect(totals).toEqual({
      questionCount: 9,
      conversationCount: 3,
      answers: { answered: 3, partial: 1, unanswered: 2, unclear: 1, outOfScope: 1, notAssessed: 1 },
      contentGapEligibleCount: 3,
      unclassified: {
        questionCount: 5,
        answers: { answered: 1, partial: 1, unanswered: 0, unclear: 1, outOfScope: 1, notAssessed: 1 },
        contentGapEligibleCount: 1,
      },
    });
    expect(answerTotal(totals.answers)).toBe(totals.questionCount);
    expect(answerTotal(totals.unclassified.answers)).toBe(totals.unclassified.questionCount);
  });

  it("gives every UTC day the period touches an entry, zero-filled and ascending", () => {
    const { dailyVolume } = summarizeAudiencePulsePopulation({
      period,
      population: population(),
      classifiedIds: new Set(),
    });

    expect(dailyVolume).toEqual([
      { day: "2026-07-01", questionCount: 3, conversationCount: 2, answeredCount: 2, contentGapEligibleCount: 1 },
      { day: "2026-07-02", questionCount: 0, conversationCount: 0, answeredCount: 0, contentGapEligibleCount: 0 },
      { day: "2026-07-03", questionCount: 3, conversationCount: 2, answeredCount: 1, contentGapEligibleCount: 1 },
      { day: "2026-07-04", questionCount: 3, conversationCount: 1, answeredCount: 0, contentGapEligibleCount: 1 },
    ]);
  });

  it("stops before a period that ends exactly at midnight", () => {
    const { dailyVolume } = summarizeAudiencePulsePopulation({
      period: { start: new Date("2026-07-01T00:00:00.000Z"), end: new Date("2026-07-03T00:00:00.000Z") },
      population: [],
      classifiedIds: new Set(),
    });

    expect(dailyVolume.map((entry) => entry.day)).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("counts each channel, the largest first, with the channel-less questions as their own row", () => {
    const { channels } = summarizeAudiencePulsePopulation({
      period,
      population: population(),
      classifiedIds: new Set(),
    });

    expect(channels).toEqual([
      { channel: "web", questionCount: 5, answeredCount: 2, contentGapEligibleCount: 2 },
      { channel: "email", questionCount: 3, answeredCount: 0, contentGapEligibleCount: 1 },
      { channel: null, questionCount: 1, answeredCount: 1, contentGapEligibleCount: 0 },
    ]);
  });
});

describe("report totals", () => {
  const censusInput = () => {
    const items = population();
    return {
      period,
      generatedAt: new Date("2026-07-04T12:00:00.000Z"),
      isFirstCensus: false,
      coverage: { populationSize: items.length, sampleSize: items.length, sampled: false, facetReadyQuestionCount: items.length },
      weeklyVolume: [{ weekStart: "2026-06-29T00:00:00.000Z", visitorQuestionCount: items.length, conversationCount: 3 }],
      population: items,
      topics: [
        { id: "topic-plans", title: "Plans", description: "Plans.", evidenceIds: ["evidence-1", "evidence-3", "evidence-5"] },
        { id: "topic-billing", title: "Billing", description: "Billing.", evidenceIds: ["evidence-4", "evidence-6"] },
      ],
    };
  };

  it("adds up: topics plus the unclassified remainder make the totals, bucket by bucket, day by day, channel by channel", () => {
    const { report } = buildAudiencePulseCensusReport(censusInput());
    const totals = report.totals!;

    expect(totals.questionCount).toBe(report.coverage.populationSize);
    expect(answerTotal(totals.answers)).toBe(totals.questionCount);
    expect(report.themes.reduce((sum, theme) => sum + theme.memberCount, 0) + totals.unclassified.questionCount)
      .toBe(totals.questionCount);
    expect(totals.unclassified.questionCount).toBe(report.unclassifiedQuestionCount);
    expect(sumAnswers([...report.themes.map((theme) => theme.answers!), totals.unclassified.answers]))
      .toEqual(totals.answers);
    expect(report.dailyVolume!.reduce((sum, entry) => sum + entry.questionCount, 0)).toBe(totals.questionCount);
    expect(report.channels!.reduce((sum, entry) => sum + entry.questionCount, 0)).toBe(totals.questionCount);
  });

  it("carries the previous period and the snapshot the topic comparisons were read from", () => {
    const previousPeriod = {
      period: { start: "2026-06-01T12:00:00.000Z", end: "2026-07-01T12:00:00.000Z" },
      questionCount: 4,
      conversationCount: 2,
      answeredCount: 3,
      contentGapEligibleCount: 1,
    };
    const { report } = buildAudiencePulseCensusReport({
      ...censusInput(),
      previousPeriod,
      previousGeneratedAt: "2026-06-20T08:00:00.000Z",
    });

    expect(report.previousPeriod).toEqual(previousPeriod);
    expect(report.previousGeneratedAt).toBe("2026-06-20T08:00:00.000Z");
  });

  it("reads no previous period and no compared snapshot when none were given", () => {
    const { report } = buildAudiencePulseCensusReport(censusInput());

    expect(report.previousPeriod).toBeNull();
    expect(report.previousGeneratedAt).toBeNull();
  });

  it("gives a report still waiting on topics its totals, days, channels and previous period, every question unclassified", () => {
    const items = population();
    const previousPeriod = {
      period: { start: "2026-06-01T12:00:00.000Z", end: "2026-07-01T12:00:00.000Z" },
      questionCount: 2,
      conversationCount: 1,
      answeredCount: 1,
      contentGapEligibleCount: 0,
    };
    const report = buildAudiencePulseComputingReport({
      period,
      generatedAt: new Date("2026-07-04T12:00:00.000Z"),
      isFirstCensus: true,
      coverage: { populationSize: items.length, sampleSize: items.length, sampled: false, facetReadyQuestionCount: 0 },
      weeklyVolume: [],
      population: items,
      previousPeriod,
    });

    expect(report.totals).toMatchObject({ questionCount: 9, conversationCount: 3 });
    expect(report.totals!.unclassified).toEqual({
      questionCount: report.totals!.questionCount,
      answers: report.totals!.answers,
      contentGapEligibleCount: report.totals!.contentGapEligibleCount,
    });
    expect(report.dailyVolume).toHaveLength(4);
    expect(report.channels).toHaveLength(3);
    expect(report.previousPeriod).toEqual(previousPeriod);
    expect(report.previousGeneratedAt).toBeNull();
  });
});
