import { describe, expect, it } from "vitest";

import { formatIsoDateUtc, formatPromptDateUtc, PROMPT_DATE_BUDGET_STAND_IN } from "../../src/shared/domain/clock.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { SharedAnswerInstructionBuilder } from "../../src/modules/retrieval/services/sharedAnswerInstructionBuilder.js";
import {
  ModelRerankGateway,
  RerankService,
  type RerankGateway,
  type RerankGatewayInput,
} from "../../src/modules/retrieval/services/rerankService.js";
import type { ModelInferencePipeline } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { RetrievedCandidate } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";

const candidate = (overrides: Partial<RetrievedCandidate> = {}): RetrievedCandidate => ({
  chunkId: "c1",
  documentId: "d1",
  title: "Summer Festival 2019",
  content: "Summer Festival 2019 took place on 2019-06-10.",
  similarity: 0.8,
  retrievalSources: ["semantic_original"],
  retrievalText: "Title: Summer Festival 2019\n\nSummer Festival 2019 took place on 2019-06-10.",
  semanticScore: 0.8,
  lexicalScore: 0,
  ...overrides,
});

const fixedClock = (iso: string) => () => new Date(iso);

describe("formatIsoDateUtc", () => {
  it("formats a date as UTC YYYY-MM-DD", () => {
    expect(formatIsoDateUtc(new Date("2026-06-02T23:59:59Z"))).toBe("2026-06-02");
  });

  it("zero-pads month and day", () => {
    expect(formatIsoDateUtc(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
  });
});

describe("formatPromptDateUtc", () => {
  it("names the UTC day's weekday after its ISO date, so a prompt can count days from it", () => {
    expect(formatPromptDateUtc(new Date("2026-10-21T23:30:00Z"))).toBe("2026-10-21 (Wednesday)");
    expect(formatPromptDateUtc(new Date("2026-10-25T00:00:00Z"))).toBe("2026-10-25 (Sunday)");
    expect(formatPromptDateUtc(new Date("2026-10-26T00:00:00Z"))).toBe("2026-10-26 (Monday)");
  });

  it("is never longer than the planner's budget stand-in", () => {
    const week = Array.from({ length: 7 }, (_value, day) => new Date(Date.UTC(2026, 9, 19 + day)));
    for (const day of week) {
      expect(formatPromptDateUtc(day).length).toBeLessThanOrEqual(PROMPT_DATE_BUDGET_STAND_IN.length);
    }
  });
});

describe("rerank recency date", () => {
  it("RerankService forwards today (from its clock) to the gateway", async () => {
    let captured: RerankGatewayInput | undefined;
    const gateway: RerankGateway = {
      async rerank(input) {
        captured = input;
        return [{ chunkId: input.contexts[0].chunkId, relevanceScore: 0.9 }];
      },
    };
    const service = new RerankService(gateway, undefined, fixedClock("2026-06-02T10:00:00Z"));

    await service.rerank({
      query: "what events are coming up",
      contexts: [candidate()],
      enabled: true,
      topK: 5,
    });

    expect(captured?.today).toBe("2026-06-02 (Tuesday)");
  });

  it("ModelRerankGateway renders today into the rerank prompt", async () => {
    let capturedPrompt = "";
    const client = {
      metadata: { provider: "test", model: "test-model" },
      async complete(request: { prompt?: string }) {
        capturedPrompt = request.prompt ?? "";
        return { text: '{"scores":[{"candidateIndex":1,"relevanceScore":0.9}]}' };
      },
      stream() {
        throw new Error("unused");
      },
    } as unknown as ModelInferencePipeline;
    const gateway = new ModelRerankGateway(client);

    await gateway.rerank({
      query: "what events are coming up",
      contexts: [candidate()],
      today: "2026-06-02",
    });

    expect(capturedPrompt).toContain("2026-06-02");
  });
});

describe("answer prompt recency date", () => {
  it("PromptBuilder renders the current date into the answer system prompt", () => {
    const builder = new PromptBuilder(new SharedAnswerInstructionBuilder(), fixedClock("2026-06-02T10:00:00Z"));

    const result = builder.build({
      query: "what events are coming up",
      history: [],
      contexts: [],
      settings: {},
    });

    expect(result.systemPrompt).toContain("2026-06-02");
  });
});

describe("recency prompt templates", () => {
  it("rerank.md carries the today reference and a recency rule", () => {
    const template = loadPromptTemplate("retrieval/rerank.md");
    expect(template).toContain("{{today}}");
    expect(template).toMatch(/upcoming|already (?:passed|happened)|past period/i);
  });

  it("answer.md carries the today reference and recency guidance", () => {
    const template = loadPromptTemplate("retrieval/answer.md");
    expect(template).toContain("{{today}}");
    expect(template).toMatch(/current or upcoming|already (?:passed|happened)/i);
  });
});
