import { describe, expect, it, vi } from "vitest";

import { RequestedDateRangeSearchService } from "../../../src/modules/retrieval/services/requestedDateRangeSearchService.js";
import type { QueryEmbeddingRequest } from "../../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";
import type { TemporalCandidateRetrievalInput } from "../../../src/modules/retrieval/domain/temporal/temporalCandidateRetrieval.js";

const RANGE = { dateFrom: "2027-01-03", dateTo: "2027-01-06" };
const SPACE = { id: "space-1", dimensions: 3, distanceMetric: "cosine" as const };
const USAGE_CONTEXT = {
  workspaceId: "workspace-1",
  requestId: "request-1",
  surface: "documents",
  attemptKey: "document_search",
  copilotConversationId: null,
  copilotMessageId: null,
};

const chunk = (overrides: Record<string, unknown> = {}) => ({
  documentId: "d1",
  chunkId: "c1",
  title: "January listing",
  content: "Runs 3-6 January 2027.",
  similarity: 0.6,
  metadata: {},
  ...overrides,
});

const deps = (overrides: Record<string, unknown> = {}) => {
  const queryEmbeddings = {
    embedQueries: vi.fn(async (_request: QueryEmbeddingRequest) => ({ space: SPACE, vectors: [[0.1, 0.2, 0.3]] })),
  };
  const temporalCandidateRetrieval = {
    findInWindow: vi.fn(async (_request: TemporalCandidateRetrievalInput) => [chunk()]),
  };
  const retrievalDefaultsProvider = {
    getDefaults: vi.fn(() => ({ rerankTopK: 5 }) as never),
  };
  return { queryEmbeddings, temporalCandidateRetrieval, retrievalDefaultsProvider, ...overrides };
};

const service = (d: ReturnType<typeof deps>) => new RequestedDateRangeSearchService(
  d.queryEmbeddings as never,
  d.temporalCandidateRetrieval as never,
  d.retrievalDefaultsProvider as never,
);

describe("RequestedDateRangeSearchService", () => {
  it("ranks the lookup by the query's own embedding when embedding succeeds", async () => {
    const d = deps();
    const result = await service(d).search({
      workspaceId: "workspace-1",
      query: "which courses run from 3 to 6 January 2027",
      range: RANGE,
      usageContext: USAGE_CONTEXT,
    });

    expect(result.status).toBe("ran");
    expect(result.chunks).toEqual([chunk()]);
    expect(d.temporalCandidateRetrieval.findInWindow).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      window: expect.objectContaining({
        kind: "requested_range",
        range: RANGE,
        similarTo: { space: SPACE, queryVector: [0.1, 0.2, 0.3] },
      }),
    }));
  });

  it("degrades to a date-ordered lookup, without failing the call, when embedding fails", async () => {
    const d = deps({
      queryEmbeddings: { embedQueries: vi.fn(async () => { throw new Error("embedding provider unavailable"); }) },
    });

    const result = await service(d).search({
      workspaceId: "workspace-1",
      query: "which courses run from 3 to 6 January 2027",
      range: RANGE,
      usageContext: USAGE_CONTEXT,
    });

    expect(result.status).toBe("ran");
    expect(result.chunks).toEqual([chunk()]);
    const call = d.temporalCandidateRetrieval.findInWindow.mock.calls[0]?.[0] as { window: Record<string, unknown> };
    expect(call.window).not.toHaveProperty("similarTo");
  });

  it("degrades to a date-ordered lookup when the embedding's dimensions do not match the active space", async () => {
    const d = deps({
      queryEmbeddings: { embedQueries: vi.fn(async () => ({ space: SPACE, vectors: [[0.1, 0.2]] })) },
    });

    const result = await service(d).search({
      workspaceId: "workspace-1",
      query: "which courses run from 3 to 6 January 2027",
      range: RANGE,
      usageContext: USAGE_CONTEXT,
    });

    expect(result.status).toBe("ran");
    const call = d.temporalCandidateRetrieval.findInWindow.mock.calls[0]?.[0] as { window: Record<string, unknown> };
    expect(call.window).not.toHaveProperty("similarTo");
  });

  it("reports failed, with no chunks, rather than throwing, when the structured lookup itself errors", async () => {
    const d = deps({
      temporalCandidateRetrieval: { findInWindow: vi.fn(async () => { throw new Error("db unavailable"); }) },
    });

    const result = await service(d).search({
      workspaceId: "workspace-1",
      query: "which courses run from 3 to 6 January 2027",
      range: RANGE,
      usageContext: USAGE_CONTEXT,
    });

    expect(result.status).toBe("failed");
    expect(result.chunks).toEqual([]);
  });

  it("passes the metadata filter through to the structured lookup", async () => {
    const d = deps();

    await service(d).search({
      workspaceId: "workspace-1",
      query: "which courses run from 3 to 6 January 2027",
      range: RANGE,
      metadataFilter: { department: "training" },
      usageContext: USAGE_CONTEXT,
    });

    expect(d.temporalCandidateRetrieval.findInWindow).toHaveBeenCalledWith(expect.objectContaining({
      metadataFilter: { department: "training" },
    }));
  });

  it("uses the pipeline's own depth rule, raised by the workspace's rerankTopK", async () => {
    const d = deps({
      retrievalDefaultsProvider: { getDefaults: vi.fn(() => ({ rerankTopK: 5 }) as never) },
    });

    await service(d).search({
      workspaceId: "workspace-1",
      query: "which courses run from 3 to 6 January 2027",
      range: RANGE,
      usageContext: USAGE_CONTEXT,
    });

    expect(d.temporalCandidateRetrieval.findInWindow).toHaveBeenCalledWith(expect.objectContaining({ topK: 40 }));
  });

  it("forwards the caller's usage context to the embedding call, attributed per request rather than hardcoded", async () => {
    const d = deps();
    const firstUsageContext = { ...USAGE_CONTEXT, requestId: "request-a" };
    const secondUsageContext = { ...USAGE_CONTEXT, requestId: "request-b" };

    await service(d).search({ workspaceId: "workspace-1", query: "q", range: RANGE, usageContext: firstUsageContext });
    await service(d).search({ workspaceId: "workspace-1", query: "q", range: RANGE, usageContext: secondUsageContext });

    const calls = d.queryEmbeddings.embedQueries.mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ usageContext: expect.objectContaining({ requestId: "request-a" }) });
    expect(calls[1]?.[0]).toMatchObject({ usageContext: expect.objectContaining({ requestId: "request-b" }) });
    expect((calls[0]?.[0] as { usageContext: { requestId: string } }).usageContext.requestId)
      .not.toBe((calls[1]?.[0] as { usageContext: { requestId: string } }).usageContext.requestId);
  });
});
