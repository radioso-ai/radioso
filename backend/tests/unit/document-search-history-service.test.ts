import { describe, expect, it } from "vitest";

import { DocumentSearchHistoryService } from "../../src/modules/documents/services/documentSearchHistoryService.js";
import {
  InMemoryAuditEventRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";

describe("document search history service", () => {
  it("falls back to a legacy label for malformed search audit metadata", async () => {
    const auditRepository = new InMemoryAuditEventRepository();
    const documentRepository = new InMemoryDocumentRepository();
    const service = new DocumentSearchHistoryService(auditRepository, documentRepository);

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "document.search",
      eventStatus: "success",
      metadata: {
        searchId: "search-1",
        results: "invalid-results-shape",
        retrievalTrace: "invalid-trace-shape",
      } as unknown as Record<string, unknown>,
    });

    const list = await service.listHistory("workspace-1");
    expect(list).toEqual({
      hasMore: false,
      nextCursor: null,
      searches: [
        {
          searchId: "search-1",
          query: "Legacy search",
          createdAt: expect.any(String),
          resultCount: 0,
          traceAvailable: false,
          previewTopTitles: [],
        },
      ],
      total: 1,
    });

    const replay = await service.getHistory("workspace-1", "search-1");
    expect(replay).toEqual({
      searchId: "search-1",
      mode: "snapshot",
      query: "Legacy search",
      resultCount: 0,
      results: [],
      retrievalTrace: undefined,
    });
  });
});
