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
