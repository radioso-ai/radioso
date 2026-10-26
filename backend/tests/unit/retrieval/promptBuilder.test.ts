import { describe, expect, it } from "vitest";

import type { FinalPromptContext } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { PromptBuilder } from "../../../src/modules/retrieval/services/promptBuilder.js";

const wordpressContext = (metadata: Record<string, unknown>): FinalPromptContext =>
  ({
    chunkId: "chunk-49642",
    documentId: "document-49642",
    title: "Who Was Swamiji, Really?",
    content: "There are encounters that change your life.",
    metadata,
    similarity: 0.9,
    retrievalSources: ["semantic_original"],
    retrievalText: "Who Was Swamiji, Really?",
    semanticScore: 0.9,
    lexicalScore: 0,
    relevanceScore: 0.9,
    rerankPosition: 0,
    promptPosition: 0,
    estimatedTokenCost: 20,
  });

describe("PromptBuilder context metadata", () => {
  it("keeps a WordPress author and publish date available to the grounded answer", () => {
    const result = new PromptBuilder().build({
      query: "Who wrote this article and when was it published?",
      history: [],
      contexts: [
        wordpressContext({
          sourceUrl: "https://anandaeurope.org/blog/2026/07/22/who-was-swamiji-really/",
          author: "Bikram Mario Liguori",
          published_at: "2026-07-22T14:16:07",
          dateFrom: "2026-07-22",
        }),
      ],
      settings: {},
    });

    expect(result.prompt).toContain(
      "Source: https://anandaeurope.org/blog/2026/07/22/who-was-swamiji-really/",
    );
    expect(result.prompt).toContain(
      "Attributes: Date from: 2026-07-22 | Author: Bikram Mario Liguori",
    );
  });

  it("does not let control-character metadata create new prompt lines", () => {
    const result = new PromptBuilder().build({
      query: "What is this?",
      history: [],
      contexts: [
        wordpressContext({
          author: "Bikram Mario\nLiguori",
          published_at: "tomorrow\nnot-a-date",
        }),
      ],
      settings: {},
    });

    expect(result.prompt).toContain("Attributes: Author: Bikram Mario Liguori");
    expect(result.prompt).not.toContain("\nLiguori");
    expect(result.prompt).not.toContain("not-a-date");
  });
});

describe("PromptBuilder dates", () => {
  const wednesday = () => new Date("2026-10-21T23:30:00.000Z");
  const build = (requestedDateRange?: { dateFrom: string; dateTo: string }) =>
    new PromptBuilder(undefined, wednesday).build({
      query: "What's on this weekend?",
      history: [],
      contexts: [wordpressContext({})],
      settings: {},
      ...(requestedDateRange ? { requestedDateRange } : {}),
    });

  it("dates the answer with today's weekday, so it can count days the way the rewrite did", () => {
    expect(build().systemPrompt).toContain("The current date is 2026-10-21 (Wednesday).");
  });

  it("tells the answer the period the question asks about, in the request rather than the standing instructions", () => {
    const result = build({ dateFrom: "2026-10-24", dateTo: "2026-10-25" });

    expect(result.prompt).toContain("Requested period:\n2026-10-24 (Saturday) to 2026-10-25 (Sunday)");
    expect(result.systemPrompt).not.toContain("2026-10-24");
    expect(result.systemPrompt).not.toContain("Requested period");
  });

  it("names a single requested day once", () => {
    expect(build({ dateFrom: "2026-10-24", dateTo: "2026-10-24" }).prompt)
      .toContain("Requested period:\n2026-10-24 (Saturday)\n");
  });

  it("adds nothing to the request when the question names no period", () => {
    const withoutRange = build();
    const withRange = build({ dateFrom: "2026-10-24", dateTo: "2026-10-25" });

    expect(withoutRange.prompt).not.toContain("Requested period");
    expect(withoutRange.systemPrompt).toBe(withRange.systemPrompt);
    expect(withoutRange.prompt).toContain("Answer request:\nWhat's on this weekend?\n\nStandalone retrieval query:");
  });
});

describe("PromptBuilder period relations", () => {
  const wednesday = () => new Date("2026-10-21T23:30:00.000Z");
  // Saturday 24 to Sunday 25 October 2026.
  const weekend = { dateFrom: "2026-10-24", dateTo: "2026-10-25" };
  const datedContext = (title: string, metadata: Record<string, unknown>): FinalPromptContext => ({
    ...wordpressContext(metadata),
    chunkId: `chunk-${title}`,
    documentId: `document-${title}`,
    title,
    content: `${title} at the riverside hall.`,
  });
  const build = (contexts: FinalPromptContext[], requestedDateRange?: { dateFrom: string; dateTo: string }) =>
    new PromptBuilder(undefined, wednesday).build({
      query: "What's on this weekend?",
      history: [],
      contexts,
      settings: {},
      ...(requestedDateRange ? { requestedDateRange } : {}),
    });

  it("states how a dated excerpt sits against the requested period, under its attributes", () => {
    const { prompt } = build([datedContext("Lantern walk", { dateFrom: "2026-10-23", dateTo: "2026-10-25" })], weekend);

    expect(prompt).toContain(
      "Result 1 (Lantern walk): Attributes: Date from: 2026-10-23 | Date to: 2026-10-25\n"
        + "Period relation: dated 2026-10-23 (Friday) to 2026-10-25 (Sunday); begins 1 day before the requested period and ends inside it\n"
        + "Lantern walk at the riverside hall.",
    );
  });

  it.each([
    ["inside, on one day", { dateFrom: "2026-10-24" }, "dated 2026-10-24 (Saturday); inside the requested period"],
    [
      "inside, over several days",
      { dateFrom: "2026-10-24", dateTo: "2026-10-25" },
      "dated 2026-10-24 (Saturday) to 2026-10-25 (Sunday); begins and ends inside the requested period",
    ],
    [
      "beginning inside and ending after",
      { dateFrom: "2026-10-25", dateTo: "2026-11-01" },
      "dated 2026-10-25 (Sunday) to 2026-11-01 (Sunday); begins inside the requested period and ends 7 days after it",
    ],
    [
      "spanning it",
      { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
      "dated 2026-10-01 (Thursday) to 2026-10-31 (Saturday); begins 23 days before the requested period and ends 6 days after it, covering all of it",
    ],
    [
      "entirely before",
      { dateFrom: "2026-10-20", dateTo: "2026-10-22" },
      "dated 2026-10-20 (Tuesday) to 2026-10-22 (Thursday); entirely before the requested period, ending 2 days before it begins",
    ],
    [
      "entirely after",
      { dateTo: "2026-10-26" },
      "dated 2026-10-26 (Monday); entirely after the requested period, beginning 1 day after it ends",
    ],
  ])("states an excerpt %s", (_label, dates, relation) => {
    expect(build([datedContext("Item", dates)], weekend).prompt).toContain(`\nPeriod relation: ${relation}\n`);
  });

  it("points the requested-period instructions at the relation the excerpts carry", () => {
    const { prompt } = build([datedContext("Lantern walk", { dateFrom: "2026-10-23", dateTo: "2026-10-25" })], weekend);
    const instructions = prompt.slice(prompt.indexOf("Requested period:"), prompt.indexOf("Standalone retrieval query:"));

    expect(instructions).toContain("Period relation");
  });

  it("states no relation for an undated excerpt, or for one whose dates are not calendar dates", () => {
    const { prompt } = build(
      [datedContext("Gift shop", {}), datedContext("Bad date", { dateFrom: "2026-02-30" })],
      weekend,
    );

    expect(prompt).not.toContain("Period relation:");
  });

  it("states no relation when the question names no period", () => {
    const withoutRange = build([datedContext("Lantern walk", { dateFrom: "2026-10-23", dateTo: "2026-10-25" })]);

    expect(withoutRange.prompt).not.toContain("Period relation");
  });

  it("keeps the relation in the request, leaving the standing instructions unchanged", () => {
    const contexts = [datedContext("Lantern walk", { dateFrom: "2026-10-23", dateTo: "2026-10-25" })];

    expect(build(contexts, weekend).systemPrompt).toBe(build(contexts).systemPrompt);
  });
});
