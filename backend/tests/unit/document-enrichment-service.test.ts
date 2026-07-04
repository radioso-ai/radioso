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
    expect(result.provenance).toMatchObject({ shape: "event", status: "applied", model: "gpt-5.2" });
    expect(result.documentMetadata).not.toHaveProperty("enrichment");
    expect(result.chunks[0]?.metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
  });

  it("fails open with safe provenance when model output is invalid", async () => {
    const service = new DocumentEnrichmentService({
      gateway: {
        generate: vi.fn().mockResolvedValue({
          model: "gpt-5.2",
          output: {
            shape: "event",
            confidence: 0.8,
            facts: [
              {
                id: "f1",
                kind: "event_date",
                label: "out of bounds",
                dateFrom: "2026-08-10",
                sourceRange: { start: 10, end: 9999 },
              },
            ],
          },
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
    expect(result.provenance).toMatchObject({ status: "failed" });
    expect(String(result.provenance.failureReason)).toContain("invalid_output");
    expect(result.documentMetadata).not.toHaveProperty("enrichment");
  });

  it("tolerates fenced JSON, null optional fields, and degenerate facts from the model", async () => {
    const service = new DocumentEnrichmentService({
      gateway: {
        generate: vi.fn().mockImplementation(({ documentRepresentation }: { documentRepresentation: string }) => {
          const bodyStart = documentRepresentation.indexOf("Corso residenziale");
          return Promise.resolve({
            model: "gpt-5.2",
            output: {
              shape: "event",
              confidence: 0.9,
              facts: [
                {
                  id: "f1",
                  kind: "event_date",
                  label: "Corso residenziale",
                  dateFrom: "2026-07-03",
                  dateTo: null,
                  unresolvedText: "",
                  anchorDate: null,
                  sourceRange: { start: bodyStart, end: bodyStart + 20 },
                },
                {
                  id: "f2",
                  kind: "event_date",
                  label: "empty",
                  dateFrom: null,
                  unresolvedText: null,
                  sourceRange: { start: bodyStart, end: bodyStart + 5 },
                },
              ],
            },
          });
        }),
      },
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    });

    const result = await service.enrich({
      document: {
        id: "doc-1",
        workspaceId: "workspace-1",
        title: "Corso",
        markdownContent: "Corso residenziale dal 03/07/2026 al 05/07/2026.",
        metadata: {},
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      chunks: [
        { chunkIndex: 0, startOffset: 0, endOffset: 48, metadata: {} },
      ],
      anchor: { source: "document_created_at", date: "2026-07-01" },
    });

    expect(result.status).toBe("applied");
    expect(result.factCount).toBe(1);
    expect(result.chunks[0]?.metadata).toMatchObject({ dateFrom: "2026-07-03" });
  });
});
