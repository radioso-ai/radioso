import { describe, expect, it, vi } from "vitest";

import { DocumentSearchService } from "../../src/modules/documents/services/documentSearchService.js";

const document = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Runbook",
  status: "ready",
  metadata: {},
  sourceKind: "inline_text" as const,
};

const retrievalResult = {
  rewrittenQuery: "how do I deploy",
  contexts: [{ documentId: document.id, content: "Deploy with the release command.", relevanceScore: 0.9 }],
  systemPrompt: "",
  prompt: "",
  citations: [],
  responseIdentity: null,
  responseSettings: {
    citationDisplayEnabled: true,
    suggestedQuestionsEnabled: false,
    suggestedQuestionsCount: 0,
  },
  diagnostics: {},
  trace: {} as never,
};

describe("DocumentSearchService commit boundary", () => {
  it("records the search audit before returning a successful live result", async () => {
    const order: string[] = [];
    const audit = {
      record: vi.fn(async () => {
        order.push("audit");
      }),
    };
    const retrieval = {
      run: vi.fn(async () => {
        order.push("retrieval");
        return retrievalResult;
      }),
    };
    const documents = {
      listSummariesByIdsAndWorkspaceId: vi.fn(async () => {
        order.push("documents");
        return [document];
      }),
    };

    const result = await new DocumentSearchService(
      documents as never,
      retrieval as never,
      audit as never,
    ).search({ workspaceId: "22222222-2222-4222-8222-222222222222", query: "how do I deploy" });

    expect(result.resultCount).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.search",
      eventStatus: "success",
    }));
    expect(order.at(-1)).toBe("audit");
  });

  it("publishes search.created only after the audit commit", async () => {
    const order: string[] = [];
    const audit = {
      record: vi.fn(async () => {
        order.push("audit");
      }),
    };
    const publisher = {
      enqueue: vi.fn(() => {
        order.push("publish");
      return { accepted: true as const, coalesced: false };
      }),
    };
    const service = new DocumentSearchService(
      { listSummariesByIdsAndWorkspaceId: vi.fn(async () => [document]) } as never,
      { run: vi.fn(async () => retrievalResult) } as never,
      audit as never,
      publisher,
    );

    await service.search({ workspaceId: "22222222-2222-4222-8222-222222222222", query: "how do I deploy" });

    expect(publisher.enqueue).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", ["search.created"]);
    expect(order).toEqual(["audit", "publish"]);
  });

  it("does not return a search result when the authoritative audit write fails", async () => {
    const audit = {
      record: vi.fn(async () => {
        throw new Error("audit transaction unavailable");
      }),
    };
    const service = new DocumentSearchService(
      { listSummariesByIdsAndWorkspaceId: vi.fn(async () => [document]) } as never,
      { run: vi.fn(async () => retrievalResult) } as never,
      audit as never,
    );

    await expect(service.search({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      query: "how do I deploy",
    })).rejects.toThrow("audit transaction unavailable");
  });
});

const workspaceId = "22222222-2222-4222-8222-222222222222";
const decemberDocument = { id: "d1111111-1111-4111-8111-111111111111", title: "December listing", status: "ready", metadata: {}, sourceKind: "inline_text" as const };
const januaryDocument = { id: "d2222222-2222-4222-8222-222222222222", title: "January listing", status: "ready", metadata: {}, sourceKind: "inline_text" as const };

const dateRangeDeps = (overrides: Record<string, unknown> = {}) => {
  const audit = { record: vi.fn(async () => {}) };
  const retrieval = {
    run: vi.fn(async () => ({
      ...retrievalResult,
      contexts: [{ documentId: decemberDocument.id, content: "Runs every December.", relevanceScore: 0.9 }],
    })),
  };
  const documents = {
    listSummariesByIdsAndWorkspaceId: vi.fn(async (_workspaceId: string, ids: string[]) =>
      [decemberDocument, januaryDocument].filter((candidate) => ids.includes(candidate.id))),
  };
  const queryEmbeddings = {
    embedQueries: vi.fn(async () => ({
      space: { provider: "openai", model: "text-embedding-3-small", dimensions: 3 },
      vectors: [[0.1, 0.2, 0.3]],
    })),
  };
  const temporalCandidateRetrieval = {
    findInWindow: vi.fn(async () => [{
      documentId: januaryDocument.id,
      chunkId: "c-january",
      title: "January listing",
      content: "Runs 3-6 January 2027.",
      similarity: 0.6,
      metadata: {},
    }]),
  };
  return { audit, retrieval, documents, queryEmbeddings, temporalCandidateRetrieval, ...overrides };
};

const dateRangeService = (deps: ReturnType<typeof dateRangeDeps>) => new DocumentSearchService(
  deps.documents as never,
  deps.retrieval as never,
  deps.audit as never,
  undefined,
  deps.temporalCandidateRetrieval,
  deps.queryEmbeddings as never,
);

describe("DocumentSearchService requested date range", () => {
  it("leaves behavior unchanged, and never embeds or runs the temporal lookup, when no range is given", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    const result = await service.search({ workspaceId, query: "course listings" });

    expect(deps.queryEmbeddings.embedQueries).not.toHaveBeenCalled();
    expect(deps.temporalCandidateRetrieval.findInWindow).not.toHaveBeenCalled();
    expect(result.results.map((entry) => entry.documentId)).toEqual([decemberDocument.id]);
  });

  it("ranks a document found only through the requested-range lookup ahead of a higher-scoring similarity match", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    const result = await service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    });

    expect(result.results.map((entry) => entry.documentId)).toEqual([januaryDocument.id, decemberDocument.id]);
  });

  it("reuses the temporal candidate port with the requested range and the query's own embedding as the similarity ranking", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    await service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    });

    expect(deps.queryEmbeddings.embedQueries).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      texts: ["which courses run from 3 to 6 January 2027"],
    }));
    expect(deps.temporalCandidateRetrieval.findInWindow).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      window: expect.objectContaining({
        kind: "requested_range",
        range: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
        similarTo: { space: { provider: "openai", model: "text-embedding-3-small", dimensions: 3 }, queryVector: [0.1, 0.2, 0.3] },
      }),
    }));
  });

  it("rejects an invalid range the same way readRequestedDateRange would", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    await expect(service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-06",
      dateTo: "2027-01-03",
    })).rejects.toThrow();
    expect(deps.temporalCandidateRetrieval.findInWindow).not.toHaveBeenCalled();
  });
});
