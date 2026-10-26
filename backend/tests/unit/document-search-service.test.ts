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

const januaryChunk = (overrides: Record<string, unknown> = {}) => ({
  documentId: januaryDocument.id,
  chunkId: "c-january",
  title: "January listing",
  content: "Runs 3-6 January 2027.",
  similarity: 0.6,
  metadata: {},
  ...overrides,
});

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
  const requestedDateRangeSearch = {
    search: vi.fn(async (_request: Record<string, unknown>) => ({ status: "ran" as const, chunks: [januaryChunk()] })),
  };
  return { audit, retrieval, documents, requestedDateRangeSearch, ...overrides };
};

const dateRangeService = (deps: ReturnType<typeof dateRangeDeps>) => new DocumentSearchService(
  deps.documents as never,
  deps.retrieval as never,
  deps.audit as never,
  undefined,
  deps.requestedDateRangeSearch as never,
);

describe("DocumentSearchService requested date range", () => {
  it("leaves behavior unchanged, and never calls the date-range port, when no range is given", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    const result = await service.search({ workspaceId, query: "course listings" });

    expect(deps.requestedDateRangeSearch.search).not.toHaveBeenCalled();
    expect(result.results.map((entry) => entry.documentId)).toEqual([decemberDocument.id]);
    expect(result.dateRangeLookup).toEqual({ status: "not_requested", candidateCount: 0 });
    expect(result.results[0]?.datedInRequestedRange).toBeNull();
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
    expect(result.dateRangeLookup).toEqual({ status: "ran", candidateCount: 1 });
    expect(result.results[0]?.datedInRequestedRange).toBe(true);
    expect(result.results[1]?.datedInRequestedRange).toBe(false);
  });

  it("delegates to the retrieval-owned port with the range, the query, and the usage context", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    await service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
      executionSurface: "operator_copilot",
      copilotConversationId: "copilot-conversation-1",
      copilotMessageId: "copilot-message-1",
    });

    expect(deps.requestedDateRangeSearch.search).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      range: { dateFrom: "2027-01-03", dateTo: "2027-01-06" },
      usageContext: expect.objectContaining({
        workspaceId,
        surface: "operator_copilot",
        copilotConversationId: "copilot-conversation-1",
        copilotMessageId: "copilot-message-1",
      }),
    }));
  });

  it("passes the metadata filter through to the date-range port", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    await service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
      metadataFilter: { department: "training" },
    });

    expect(deps.requestedDateRangeSearch.search).toHaveBeenCalledWith(expect.objectContaining({
      metadataFilter: { department: "training" },
    }));
  });

  it("gives each search a distinct usage requestId, so embedding usage is never deduplicated across requests", async () => {
    const deps = dateRangeDeps();
    const service = dateRangeService(deps);

    await service.search({ workspaceId, query: "q", dateFrom: "2027-01-03", dateTo: "2027-01-06" });
    await service.search({ workspaceId, query: "q", dateFrom: "2027-01-03", dateTo: "2027-01-06" });

    const calls = deps.requestedDateRangeSearch.search.mock.calls;
    const firstRequestId = (calls[0]?.[0] as { usageContext: { requestId?: string | null } }).usageContext.requestId;
    const secondRequestId = (calls[1]?.[0] as { usageContext: { requestId?: string | null } }).usageContext.requestId;
    expect(firstRequestId).toBeTruthy();
    expect(secondRequestId).toBeTruthy();
    expect(firstRequestId).not.toBe(secondRequestId);
  });

  it("returns the plain similarity results and reports the lookup as failed, rather than throwing, when the port reports a failure", async () => {
    const deps = dateRangeDeps({
      requestedDateRangeSearch: { search: vi.fn(async () => ({ status: "failed" as const, chunks: [] })) },
    });
    const service = dateRangeService(deps);

    const result = await service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    });

    expect(result.dateRangeLookup).toEqual({ status: "failed", candidateCount: 0 });
    expect(result.results.map((entry) => entry.documentId)).toEqual([decemberDocument.id]);
  });

  it("merges one document into a single result when it arrives from both the similarity search and the date-range lookup", async () => {
    const deps = dateRangeDeps({
      requestedDateRangeSearch: {
        search: vi.fn(async () => ({
          status: "ran" as const,
          chunks: [januaryChunk({ documentId: decemberDocument.id, chunkId: "c-december-dated" })],
        })),
      },
    });
    const service = dateRangeService(deps);

    const result = await service.search({
      workspaceId,
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.documentId).toBe(decemberDocument.id);
    expect(result.results[0]?.datedInRequestedRange).toBe(true);
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
    expect(deps.requestedDateRangeSearch.search).not.toHaveBeenCalled();
  });
});
