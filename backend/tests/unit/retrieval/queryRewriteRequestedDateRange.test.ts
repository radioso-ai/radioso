import { describe, expect, it } from "vitest";

import { ModelQueryRewriteGateway } from "../../../src/modules/retrieval/services/queryRewriteGateways.js";
import { parseStructuredRewrite } from "../../../src/modules/retrieval/services/queryRewriteParser.js";
import { QueryRewriteService } from "../../../src/modules/retrieval/services/queryRewriteService.js";
import type { StructuredRewriteResult } from "../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { ModelInferencePipeline } from "../../../src/shared/infra/llm/modelInferencePipeline.js";

const listingRewrite = (requestedDateRange: unknown) => JSON.stringify({
  rewrittenQuery: "events in the week of 7 December 2026",
  semanticQuery: "events in the week of 7 December 2026",
  lexicalQuery: "events December 2026",
  queryShape: "event_date_lookup",
  temporalQueryMode: "listing",
  requestedDateRange,
  turnKind: "fresh_subject",
  relatedEntities: [],
  unresolved: false,
  confidence: 0.9,
});

describe("parseStructuredRewrite requested date range", () => {
  it("keeps the range the model resolved for a question that names a period", () => {
    const result = parseStructuredRewrite(listingRewrite({ dateFrom: "2026-12-07", dateTo: "2026-12-13" }));

    expect(result.requestedDateRange).toEqual({ dateFrom: "2026-12-07", dateTo: "2026-12-13" });
    expect(result.temporalQueryMode).toBe("listing");
  });

  it("has no range when the model returns null", () => {
    expect(parseStructuredRewrite(listingRewrite(null)).requestedDateRange).toBeUndefined();
  });

  it("drops an unusable range and keeps the rest of the rewrite", () => {
    const result = parseStructuredRewrite(listingRewrite({ dateFrom: "2026-12-13", dateTo: "2026-12-07" }));

    expect(result.requestedDateRange).toBeUndefined();
    expect(result.temporalQueryMode).toBe("listing");
    expect(result.lexicalQuery).toBe("events December 2026");
  });
});

describe("QueryRewriteService requested date range", () => {
  const emptyContextWindow = { selectedMessages: [], truncated: false, selectionReason: "recent" };
  const proposal = (requestedDateRange?: StructuredRewriteResult["requestedDateRange"]): StructuredRewriteResult => ({
    rewrittenQuery: "corsi a marzo 2027",
    semanticQuery: "corsi a marzo 2027",
    lexicalQuery: "corsi marzo 2027",
    queryShape: "event_date_lookup",
    temporalQueryMode: "listing",
    ...(requestedDateRange ? { requestedDateRange } : {}),
    turnKind: "fresh_subject",
    relatedEntities: [],
    unresolved: false,
    confidence: 0.9,
  });

  it("carries a planner-proposed range into the structured rewrite", () => {
    const rewritten = new QueryRewriteService().rewriteFromProposal({
      query: "Che corsi ci sono a marzo 2027?",
      contextWindow: emptyContextWindow,
      enabled: true,
      proposal: proposal({ dateFrom: "2027-03-01", dateTo: "2027-03-31" }),
    });

    expect(rewritten.structuredResult?.requestedDateRange).toEqual({ dateFrom: "2027-03-01", dateTo: "2027-03-31" });
  });

  it("drops a proposed range that is not a usable date range", () => {
    const rewritten = new QueryRewriteService().rewriteFromProposal({
      query: "Che corsi ci sono a marzo 2027?",
      contextWindow: emptyContextWindow,
      enabled: true,
      proposal: proposal({ dateFrom: "2027-03-01", dateTo: "2027-02-31" }),
    });

    expect(rewritten.structuredResult?.requestedDateRange).toBeUndefined();
  });
});

describe("ModelQueryRewriteGateway date context", () => {
  it("gives the rewrite today's date so it can resolve a named period", async () => {
    const prompts: string[] = [];
    const inference = {
      async complete(request: { prompt: string }) {
        prompts.push(request.prompt);
        return { text: listingRewrite({ dateFrom: "2026-12-07", dateTo: "2026-12-13" }) };
      },
    } as unknown as ModelInferencePipeline;
    const gateway = new ModelQueryRewriteGateway(inference, () => new Date("2026-10-21T23:30:00.000Z"));

    const result = await gateway.rewrite({
      query: "What's on the week of 7 December?",
      contextMessages: [],
      usageContext: {
        workspaceId: "workspace-1",
        surface: "retrieval",
        operation: "query_interpretation",
        attemptKey: "rewrite",
      },
    });

    expect(prompts[0]).toContain("Today's date: 2026-10-21");
    expect(prompts[0]).toContain("requestedDateRange");
    expect(result.requestedDateRange).toEqual({ dateFrom: "2026-12-07", dateTo: "2026-12-13" });
  });
});
