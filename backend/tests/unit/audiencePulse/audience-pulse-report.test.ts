import { describe, expect, it } from "vitest";

import {
  applyAudiencePulseNarrative,
  buildAudiencePulseCensusReport,
  buildAudiencePulseComputingReport,
  buildAudiencePulseReport,
  contentGapEligible,
  parseAudiencePulseModelOutput,
  type AudiencePulseCensusTopic,
  type AudiencePulseEvidence,
  type AudiencePulseModelOutput,
} from "../../../src/modules/audiencePulse/domain/report.js";

const period = {
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-31T00:00:00.000Z"),
};

const evidence = (overrides: Partial<AudiencePulseEvidence> = {}): AudiencePulseEvidence => ({
  id: "evidence-1",
  reference: {
    messageId: "11111111-1111-1111-1111-111111111111",
    conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  },
  question: "How do I change my plan?",
  weekStart: "2026-06-29T00:00:00.000Z",
  channel: null,
  grounding: "no_support",
  contentGapEligible: true,
  ...overrides,
});

/** Builds a population of `count` evidence items, each customized by index. */
const buildPopulation = (
  count: number,
  factory: (index: number) => Partial<AudiencePulseEvidence> = () => ({}),
): AudiencePulseEvidence[] =>
  Array.from({ length: count }, (_, index) => evidence({
    id: `evidence-${index + 1}`,
    reference: {
      messageId: `msg-${index + 1}`,
      conversationId: `conv-${index + 1}`,
    },
    ...factory(index),
  }));

const emptyModel: AudiencePulseModelOutput = {
  summary: "Summary",
  themes: [],
  recommendations: [],
  caveats: [],
};

const baseInput = {
  period,
  generatedAt: new Date("2026-08-01T00:00:00.000Z"),
  isFirstCensus: false,
  coverage: { populationSize: 3, sampleSize: 3, sampled: false, facetReadyQuestionCount: 3 },
  weeklyVolume: [{
    weekStart: "2026-06-29T00:00:00.000Z",
    visitorQuestionCount: 3,
    conversationCount: 2,
  }],
};

describe("Audience Pulse report domain", () => {
  it("carries census transitions and prior full-membership counts into stored themes", () => {
    const population = buildPopulation(13);

    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 13, sampleSize: 13, sampled: false, facetReadyQuestionCount: 13 },
      population,
      topics: [{
        id: "topic-survived",
        title: "Plans",
        description: "Questions about plans.",
        evidenceIds: population.map((item) => item.id),
        transition: {
          kind: "survived",
          parentTopicIds: ["topic-before"],
          viaCentroidFallback: false,
          membershipOverlap: 0.9,
        },
      }],
      previousThemeMemberCounts: new Map([["topic-survived", 9]]),
      model: emptyModel,
    });

    expect(report.themes[0]).toMatchObject({
      memberCount: 13,
      previousMemberCount: 9,
      transition: {
        kind: "survived",
        parentTopicIds: ["topic-before"],
        viaCentroidFallback: false,
      },
    });
    expect(report).toMatchObject({
      generatedAt: baseInput.generatedAt.toISOString(),
      narrativeGeneratedAt: baseInput.generatedAt.toISOString(),
      narrativeReuseCount: 0,
      narrativeReuseMaxDrift: 0.2,
      dissolvedTopics: [],
    });
    expect(report.themes[0]!.evidenceIds).toHaveLength(12);
  });

  it("qualifies only the two typed retrieval outcomes with matching diagnostics", () => {
    expect(contentGapEligible({
      assistantAuthorship: "ai",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    })).toBe(true);
    expect(contentGapEligible({
      assistantAuthorship: "ai",
      skillName: "retrieval.answer",
      skillOutcome: "grounded_degraded",
      grounding: "degraded",
    })).toBe(true);
    expect(contentGapEligible({
      assistantAuthorship: "ai",
      skillName: "retrieval.answer",
      skillOutcome: "out_of_scope",
      grounding: "no_support",
    })).toBe(false);
    expect(contentGapEligible({
      assistantAuthorship: "human",
      skillName: "retrieval.answer",
      skillOutcome: "no_context",
      grounding: "no_support",
    })).toBe(false);
  });

  it("derives topic counts and recurring content gaps from census membership", () => {
    const population = [
      evidence(),
      evidence({
        id: "evidence-2",
        reference: {
          messageId: "22222222-2222-2222-2222-222222222222",
          conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
        question: "Can I update my subscription?",
      }),
      evidence({
        id: "evidence-3",
        reference: {
          messageId: "33333333-3333-3333-3333-333333333333",
          conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
        grounding: "grounded",
        contentGapEligible: false,
      }),
    ];
    const topics: AudiencePulseCensusTopic[] = [{
      id: "topic-subscriptions",
      title: "Subscription changes",
      description: "Questions about changing a plan.",
      evidenceIds: ["evidence-1", "evidence-2", "evidence-3"],
    }];

    const report = buildAudiencePulseReport({
      ...baseInput,
      population,
      topics,
      model: {
        ...emptyModel,
        summary: "Visitors ask about subscription changes.",
        recommendations: [{
          themeIndex: 0,
          title: "Explain subscription changes",
          rationale: "Repeated unsupported questions.",
          questions: ["How can I change my plan?"],
        }],
      },
    });

    expect(report.themes[0]?.grounding).toEqual({
      grounded: 1,
      degraded: 0,
      noSupport: 2,
      unknown: 0,
      contentGapEligible: 2,
    });
    expect(report.contentGaps).toEqual([{
      themeId: "topic-subscriptions",
      eligibleEvidenceCount: 2,
      distinctConversationCount: 2,
    }]);
    expect(report.recommendations).toHaveLength(1);
  });

  it("rejects evidence reused across two topics", () => {
    expect(() => buildAudiencePulseReport({
      ...baseInput,
      population: [evidence(), evidence({ id: "evidence-2" }), evidence({ id: "evidence-3" })],
      topics: [
        { id: "topic-a", title: "First", description: "First topic", evidenceIds: ["evidence-1", "evidence-2"] },
        { id: "topic-b", title: "Second", description: "Second topic", evidenceIds: ["evidence-1", "evidence-3"] },
      ],
      model: emptyModel,
    })).toThrow(/more than one topic/i);
  });

  it("omits a recommendation when its parent topic has no recurring content-gap evidence", () => {
    const report = buildAudiencePulseReport({
      ...baseInput,
      population: [
        evidence(),
        evidence({
          id: "evidence-2",
          reference: {
            messageId: "22222222-2222-2222-2222-222222222222",
            conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          },
        }),
      ],
      topics: [{ id: "topic-1", title: "Topic", description: "Description", evidenceIds: ["evidence-1", "evidence-2"] }],
      model: {
        ...emptyModel,
        recommendations: [{
          themeIndex: 0,
          title: "Recommendation",
          rationale: "Rationale",
          questions: ["Question"],
        }],
      },
    });

    expect(report.contentGaps).toEqual([]);
    expect(report.recommendations).toEqual([]);
  });

  it("owns qualifying recommendation evidence from its parent topic", () => {
    const report = buildAudiencePulseReport({
      ...baseInput,
      population: [
        evidence(),
        evidence({
          id: "evidence-2",
          reference: {
            messageId: "22222222-2222-2222-2222-222222222222",
            conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          },
        }),
        evidence({
          id: "evidence-3",
          reference: {
            messageId: "33333333-3333-3333-3333-333333333333",
            conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          },
        }),
      ],
      topics: [{
        id: "topic-1",
        title: "Topic",
        description: "Description",
        evidenceIds: ["evidence-1", "evidence-2", "evidence-3"],
      }],
      model: {
        ...emptyModel,
        recommendations: [{
          themeIndex: 0,
          title: "Recommendation",
          rationale: "Rationale",
          questions: ["Question"],
        }],
      },
    });

    expect(report.recommendations).toMatchObject([{
      themeId: "topic-1",
      evidenceIds: ["evidence-1", "evidence-3"],
    }]);
  });

  it("rejects recommendation evidence ids before report projection", () => {
    expect(() => parseAudiencePulseModelOutput({
      summary: "Summary",
      themes: [{ title: "Theme", description: "Description", evidenceIds: ["evidence-1"] }],
      recommendations: [],
      caveats: [],
    })).toThrow();

    expect(() => parseAudiencePulseModelOutput({
      summary: "Summary",
      themes: [{ title: "Theme", description: "Description", evidenceIds: ["evidence-1", "evidence-2"] }],
      recommendations: [{
        themeIndex: 0,
        title: "Recommendation",
        rationale: "Rationale",
        questions: ["Question"],
        evidenceIds: ["evidence-1", "evidence-2"],
      }],
      caveats: [],
    })).toThrow();
  });

  it("keeps model-generated prose compact", () => {
    const validOutput = {
      summary: "Summary",
      themes: [{ title: "Theme", description: "Description", evidenceIds: ["evidence-1", "evidence-2"] }],
      recommendations: [{
        themeIndex: 0,
        title: "Recommendation",
        rationale: "Rationale",
        questions: ["Question"],
      }],
      caveats: ["Caveat"],
    };

    for (const output of [
      { ...validOutput, summary: "s".repeat(301) },
      { ...validOutput, themes: [{ ...validOutput.themes[0]!, description: "d".repeat(251) }] },
      { ...validOutput, recommendations: [{ ...validOutput.recommendations[0]!, rationale: "r".repeat(251) }] },
      { ...validOutput, caveats: ["c".repeat(161)] },
    ]) {
      expect(() => parseAudiencePulseModelOutput(output)).toThrow();
    }
  });

  it("sums topic sizes plus unclassified to the exact population count", () => {
    const population = buildPopulation(20);
    const topics: AudiencePulseCensusTopic[] = [
      {
        id: "topic-a",
        title: "Topic A",
        description: "Description A",
        evidenceIds: population.slice(0, 12).map((item) => item.id),
      },
      {
        id: "topic-b",
        title: "Topic B",
        description: "Description B",
        evidenceIds: population.slice(12, 18).map((item) => item.id),
      },
    ];

    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 20, sampleSize: 20, sampled: false, facetReadyQuestionCount: 20 },
      population,
      topics,
      model: emptyModel,
    });

    expect(report.themes.map((theme) => theme.memberCount)).toEqual([12, 6]);
    expect(report.unclassifiedQuestionCount).toBe(2);
    const totalAccounted = report.themes.reduce((sum, theme) => sum + theme.memberCount, 0)
      + report.unclassifiedQuestionCount;
    expect(totalAccounted).toBe(population.length);
  });

  it("computes topic share as member count over population, summing to 1 with unclassified", () => {
    const population = buildPopulation(20);
    const topics: AudiencePulseCensusTopic[] = [
      {
        id: "topic-a",
        title: "Topic A",
        description: "Description A",
        evidenceIds: population.slice(0, 12).map((item) => item.id),
      },
      {
        id: "topic-b",
        title: "Topic B",
        description: "Description B",
        evidenceIds: population.slice(12, 18).map((item) => item.id),
      },
    ];

    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 20, sampleSize: 20, sampled: false, facetReadyQuestionCount: 20 },
      population,
      topics,
      model: emptyModel,
    });

    expect(report.themes[0]?.share).toBeCloseTo(12 / 20, 10);
    expect(report.themes[1]?.share).toBeCloseTo(6 / 20, 10);

    const unclassifiedShare = report.unclassifiedQuestionCount / population.length;
    const totalShare = report.themes.reduce((sum, theme) => sum + theme.share, 0) + unclassifiedShare;
    expect(totalShare).toBeCloseTo(1, 10);
  });

  it("reports weeklyPulse from real per-week membership without flattening a concentrated topic", () => {
    const weekBusy = "2026-06-29T00:00:00.000Z";
    const weekQuiet1 = "2026-07-06T00:00:00.000Z";
    const weekQuiet2 = "2026-07-13T00:00:00.000Z";

    const population = buildPopulation(10, (index) => ({
      weekStart: index < 8 ? weekBusy : index === 8 ? weekQuiet1 : weekQuiet2,
    }));
    const topics: AudiencePulseCensusTopic[] = [{
      id: "topic-concentrated",
      title: "Concentrated topic",
      description: "Description",
      evidenceIds: population.map((item) => item.id),
    }];

    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 10, sampleSize: 10, sampled: false, facetReadyQuestionCount: 10 },
      weeklyVolume: [
        { weekStart: weekBusy, visitorQuestionCount: 8, conversationCount: 8 },
        { weekStart: weekQuiet1, visitorQuestionCount: 1, conversationCount: 1 },
        { weekStart: weekQuiet2, visitorQuestionCount: 1, conversationCount: 1 },
      ],
      population,
      topics,
      model: emptyModel,
    });

    expect(report.themes[0]?.weeklyPulse).toEqual([
      { weekStart: weekBusy, count: 8 },
      { weekStart: weekQuiet1, count: 1 },
      { weekStart: weekQuiet2, count: 1 },
    ]);
    // An equal-allocation sampler would have flattened this to roughly one third per
    // week; real membership keeps the busy week's true weight.
    const [busy, quiet1, quiet2] = report.themes[0]!.weeklyPulse;
    expect(busy!.count).toBeGreaterThan(quiet1!.count * 2);
    expect(busy!.count).toBeGreaterThan(quiet2!.count * 2);
  });

  it("scales content-gap eligibility to a topic's real size instead of a flat sample-sized threshold", () => {
    // Two ungrounded conversations recur identically in both topics: three eligible
    // evidence items across the same two conversations. A flat threshold of two would
    // flag both. Scaled against real size, a 100-member topic needs more than three
    // ungrounded mentions to be a *recurring* gap; a 10-member topic does not.
    const eligibleOverrides = (prefix: string, index: number): Partial<AudiencePulseEvidence> => (
      index < 3
        ? {
          contentGapEligible: true,
          grounding: "no_support",
          reference: {
            messageId: `${prefix}-gap-msg-${index}`,
            conversationId: index === 1 ? `${prefix}-gap-conv-2` : `${prefix}-gap-conv-1`,
          },
        }
        : { contentGapEligible: false, grounding: "grounded" }
    );

    const largeTopicPopulation = buildPopulation(100, (index) => ({
      id: `large-${index + 1}`,
      ...eligibleOverrides("large", index),
    }));
    const smallTopicPopulation = buildPopulation(10, (index) => ({
      id: `small-${index + 1}`,
      ...eligibleOverrides("small", index),
    }));

    const population = [...largeTopicPopulation, ...smallTopicPopulation];
    const topics: AudiencePulseCensusTopic[] = [
      {
        id: "topic-large",
        title: "Large topic",
        description: "Description",
        evidenceIds: largeTopicPopulation.map((item) => item.id),
      },
      {
        id: "topic-small",
        title: "Small topic",
        description: "Description",
        evidenceIds: smallTopicPopulation.map((item) => item.id),
      },
    ];

    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: population.length, sampleSize: population.length, sampled: false, facetReadyQuestionCount: population.length },
      population,
      topics,
      model: emptyModel,
    });

    const gapTopicIds = report.contentGaps.map((gap) => gap.themeId);
    expect(gapTopicIds).not.toContain("topic-large");
    expect(gapTopicIds).toContain("topic-small");
  });

  it("drops a recommendation aimed at a topic that misses the scaled content-gap gate", () => {
    const population = buildPopulation(100, (index) => ({
      contentGapEligible: index < 3,
      reference: {
        messageId: `message-${index}`,
        conversationId: index === 1 ? "conversation-2" : "conversation-1",
      },
    }));

    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 100, sampleSize: 100, sampled: false, facetReadyQuestionCount: 100 },
      population,
      topics: [{ id: "topic-large", title: "Large", description: "Description", evidenceIds: population.map((item) => item.id) }],
      model: {
        ...emptyModel,
        recommendations: [{ themeIndex: 0, title: "Recommendation", rationale: "Rationale", questions: ["Question"] }],
      },
    });

    expect(report.contentGaps).toEqual([]);
    expect(report.recommendations).toEqual([]);
  });

  it("throws for an out-of-range recommendation topic", () => {
    expect(() => buildAudiencePulseReport({
      ...baseInput,
      population: [evidence(), evidence({ id: "evidence-2", reference: { messageId: "message-2", conversationId: "conversation-2" } })],
      topics: [{ id: "topic-1", title: "Topic", description: "Description", evidenceIds: ["evidence-1", "evidence-2"] }],
      model: { ...emptyModel, recommendations: [{ themeIndex: 1, title: "Recommendation", rationale: "Rationale", questions: ["Question"] }] },
    })).toThrow(/unknown topic/i);
  });

  it("picks up to six nearest eligible conversations for recommendation evidence", () => {
    const population = buildPopulation(8, (index) => ({
      contentGapEligible: index < 7,
      reference: { messageId: `message-${index + 1}`, conversationId: index < 2 ? "conversation-1" : `conversation-${index}` },
    }));
    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 8, sampleSize: 8, sampled: false, facetReadyQuestionCount: 8 },
      population,
      topics: [{
        id: "topic-1",
        title: "Topic",
        description: "Description",
        evidenceIds: ["evidence-2", "evidence-1", "evidence-3", "evidence-4", "evidence-5", "evidence-6", "evidence-7", "evidence-8"],
      }],
      model: {
        ...emptyModel,
        recommendations: [{ themeIndex: 0, title: "First", rationale: "Rationale", questions: ["Question"] }],
      },
    });

    expect(report.recommendations).toEqual([expect.objectContaining({
      title: "First",
      evidenceIds: ["evidence-2", "evidence-3", "evidence-4", "evidence-5", "evidence-6", "evidence-7"],
    })]);
    expect(report.contentGaps.map((gap) => gap.themeId)).toEqual(report.recommendations.map((recommendation) => recommendation.themeId));
  });

  it("rejects duplicate recommendation topic indexes instead of hiding a missing qualifying topic", () => {
    const population = buildPopulation(4, (index) => ({
      contentGapEligible: true,
      reference: { messageId: `message-${index + 1}`, conversationId: `conversation-${index + 1}` },
    }));

    expect(() => buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 4, sampleSize: 4, sampled: false, facetReadyQuestionCount: 4 },
      population,
      topics: [
        { id: "topic-1", title: "Topic 1", description: "Description", evidenceIds: ["evidence-1", "evidence-2"] },
        { id: "topic-2", title: "Topic 2", description: "Description", evidenceIds: ["evidence-3", "evidence-4"] },
      ],
      model: {
        ...emptyModel,
        recommendations: [
          { themeIndex: 0, title: "First", rationale: "Rationale", questions: ["Question"] },
          { themeIndex: 0, title: "Second", rationale: "Rationale", questions: ["Question"] },
        ],
      },
    })).toThrow(/only be referenced once/i);
  });

  it("keeps the given nearest-first display evidence order bounded to twelve", () => {
    const population = buildPopulation(13);
    const report = buildAudiencePulseReport({
      ...baseInput,
      coverage: { populationSize: 13, sampleSize: 13, sampled: false, facetReadyQuestionCount: 13 },
      population,
      topics: [{ id: "topic-1", title: "Topic", description: "Description", evidenceIds: population.map((item) => item.id).reverse() }],
      model: emptyModel,
    });

    expect(report.themes[0]?.evidenceIds).toEqual(population.map((item) => item.id).reverse().slice(0, 12));
  });

  it("applies model narrative to one precomputed census report with current gap evidence", () => {
    const population = buildPopulation(4, (index) => ({ contentGapEligible: index < 2 }));
    const census = buildAudiencePulseCensusReport({
      ...baseInput,
      coverage: { populationSize: 4, sampleSize: 4, sampled: false, facetReadyQuestionCount: 4 },
      population,
      topics: [{
        id: "topic-1",
        title: "Topic",
        description: "Description",
        evidenceIds: population.map((item) => item.id),
      }],
      dissolvedTopics: [{ id: "dissolved-topic", title: "Former topic" }],
    });

    const report = applyAudiencePulseNarrative({
      census,
      generatedAt: baseInput.generatedAt,
      model: {
        summary: "Current narrative",
        themes: [],
        recommendations: [{
          themeIndex: 0,
          title: "Document the topic",
          rationale: "Two current conversations lack support.",
          questions: ["How does this work?"],
        }],
        caveats: [],
      },
    });

    expect(report).toMatchObject({
      summary: "Current narrative",
      dissolvedTopics: [{ id: "dissolved-topic", title: "Former topic" }],
      recommendations: [{ themeId: "topic-1", evidenceIds: ["evidence-1", "evidence-2"] }],
    });
    expect(report.themes).toBe(census.report.themes);
    expect(report.contentGaps).toBe(census.report.contentGaps);
  });
});

describe("buildAudiencePulseComputingReport (spec 956 follow-up)", () => {
  it("builds a report with no themes and no narrative when nothing has been computed for the window", () => {
    const report = buildAudiencePulseComputingReport({
      period,
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      isFirstCensus: true,
      coverage: { populationSize: 104, sampleSize: 104, sampled: false, facetReadyQuestionCount: 0 },
      weeklyVolume: [{
        weekStart: "2026-06-29T00:00:00.000Z",
        visitorQuestionCount: 104,
        conversationCount: 90,
      }],
    });

    // No model ever ran, so there is nothing to narrate -- `summary` stays absent
    // rather than a hardcoded stand-in for it.
    expect(report.summary).toBeUndefined();
    expect(report).toMatchObject({
      generatedAt: "2026-08-01T00:00:00.000Z",
      isFirstCensus: true,
      narrativeGeneratedAt: "2026-08-01T00:00:00.000Z",
      narrativeReuseCount: 0,
      narrativeReuseMaxDrift: 0.2,
      dissolvedTopics: [],
    });
    expect(report.themes).toEqual([]);
    expect(report.contentGaps).toEqual([]);
    expect(report.recommendations).toEqual([]);
    expect(report.caveats).toEqual([]);
    // Every question in the window carries through as unclassified: none of them
    // could be a topic member without a facet to cluster.
    expect(report.unclassifiedQuestionCount).toBe(104);
    expect(report.coverage).toEqual({ populationSize: 104, sampleSize: 104, sampled: false, facetReadyQuestionCount: 0 });
  });
});
