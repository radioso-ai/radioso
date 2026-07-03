import { describe, expect, it, vi } from "vitest";

import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import { DocumentEnrichmentService } from "../../src/modules/documents/services/documentEnrichmentService.js";

describe("DocumentEnrichmentService", () => {
  it("makes exactly one structured model call and returns metadata patches", async () => {
    const generate = vi.fn().mockImplementation(({ documentRepresentation }: { documentRepresentation: string }) => {
      const bodyStart = documentRepresentation.indexOf("Summer workshop\n\nDates");
      return Promise.resolve({
        model: "gpt-5.2",
        output: {
          shape: "event",
          confidence: 0.91,
          facts: [
            {
              id: "workshop",
              kind: "event_date",
              label: "workshop",
              dateFrom: "2026-07-17",
              dateTo: "2026-07-19",
              sourceRange: { start: bodyStart, end: bodyStart + 41 },
            },
          ],
        },
      });
    });

    const service = new DocumentEnrichmentService({
      gateway: { generate },
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    });

    const result = await service.enrich({
      document: {
        id: "doc-1",
        workspaceId: "workspace-1",
        title: "Summer workshop",
        markdownContent: "Summer workshop\n\nDates: July 17-19, 2026.",
        metadata: {},
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      chunks: [
        {
          chunkIndex: 0,
          content: "Summer workshop\n\nDates: July 17-19, 2026.",
          startOffset: 0,
          endOffset: 43,
          metadata: {},
        },
      ],
      anchor: { source: "document_created_at", date: "2026-07-01" },
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(result.status).toBe("applied");
    expect(result.documentMetadata.enrichment).toMatchObject({ shape: "event", status: "applied", model: "gpt-5.2" });
    expect(result.chunks[0]?.metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
  });

  it("fails open with safe provenance when model output is invalid", async () => {
    const service = new DocumentEnrichmentService({
      gateway: {
        generate: vi.fn().mockResolvedValue({
          model: "gpt-5.2",
          output: { shape: "event", confidence: 0.8, facts: [{ sourceRange: { start: 10, end: 1 } }] },
        }),
      },
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    });

    const result = await service.enrich({
      document: {
        id: "doc-1",
        workspaceId: "workspace-1",
        title: "Bad",
        markdownContent: "Bad",
        metadata: {},
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      chunks: [],
      anchor: { source: "document_created_at", date: "2026-07-01" },
    });

    expect(result.status).toBe("failed");
    expect(result.documentMetadata.enrichment).toMatchObject({ status: "failed", failureReason: "invalid_output" });
  });
});
