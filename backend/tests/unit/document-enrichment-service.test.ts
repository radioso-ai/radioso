import { describe, expect, it, vi } from "vitest";

import {
  EnrichmentProviderError,
  EnrichmentReplyUnreadableError,
  type DocumentEnrichmentGateway,
  type DocumentEnrichmentRequest,
} from "../../src/modules/documents/domain/enrichment/enrichmentGateway.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import { DocumentEnrichmentService } from "../../src/modules/documents/services/documentEnrichmentService.js";

type Reply = { output: unknown } | { error: unknown };

/** A gateway that answers each request with the next scripted reply and records what it was asked. */
const scriptedGateway = (replies: Reply[]) => {
  const requests: DocumentEnrichmentRequest[] = [];
  const gateway: DocumentEnrichmentGateway = {
    async generate(request) {
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (!reply) {
        throw new Error("unscripted request");
      }
      if ("error" in reply) {
        throw reply.error;
      }
      return { model: "gpt-5.4-mini", output: reply.output };
    },
  };
  return { gateway, requests };
};

const serviceWith = (gateway: DocumentEnrichmentGateway) =>
  new DocumentEnrichmentService({
    gateway,
    strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
    now: () => new Date("2026-07-02T12:00:00.000Z"),
  });

const WORKSHOP = "Summer workshop\n\nDates: July 17-19, 2026.";

const workshopInput = (overrides: { title?: string; markdownContent?: string } = {}) => {
  const markdownContent = overrides.markdownContent ?? WORKSHOP;
  return {
    document: {
      id: "doc-1",
      workspaceId: "workspace-1",
      revision: 7,
      title: overrides.title ?? "Summer workshop",
      markdownContent,
      metadata: {},
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    chunks: [
      { chunkIndex: 0, startOffset: 0, endOffset: 15, metadata: {} },
      { chunkIndex: 1, startOffset: 17, endOffset: markdownContent.length, metadata: {} },
    ],
    anchor: { source: "document_created_at" as const, date: "2026-07-01" },
  };
};

const workshopFact = (overrides: Record<string, unknown> = {}) => ({
  kind: "event_date",
  quote: "July 17-19, 2026",
  dateFrom: "2026-07-17",
  dateTo: "2026-07-19",
  unresolvedText: null,
  ...overrides,
});

const eventOutput = (facts: unknown[]) => ({ type: "event", confidence: 0.91, facts });

describe("DocumentEnrichmentService", () => {
  it("makes one schema-constrained request and dates the chunks its quoted facts sit in", async () => {
    const { gateway, requests } = scriptedGateway([{ output: eventOutput([workshopFact()]) }]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ documentId: "doc-1", documentRevision: 7 });
    expect(requests[0]?.retry).toBeUndefined();
    expect(requests[0]?.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(result.status).toBe("applied");
    expect(result).toMatchObject({ modelAttemptCount: 1, droppedFactCount: 0, firstAttemptFailureReason: null });
    expect(result.provenance).toMatchObject({ shape: "event", status: "applied", model: "gpt-5.4-mini", droppedFactCount: 0 });
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual([
      expect.objectContaining({ dateFrom: "2026-07-17", dateTo: "2026-07-19" }),
      expect.objectContaining({ dateFrom: "2026-07-17", dateTo: "2026-07-19" }),
    ]);
  });

  it("dates only the chunk each fact is quoted from when a document carries several dates", async () => {
    const markdownContent = "Yoga: 7 December 2026\n\nKirtan: 11 December 2026";
    const { gateway } = scriptedGateway([{
      output: eventOutput([
        workshopFact({ quote: "Yoga: 7 December 2026", dateFrom: "2026-12-07", dateTo: null }),
        workshopFact({ quote: "Kirtan: 11 December 2026", dateFrom: "2026-12-11", dateTo: null }),
      ]),
    }]);

    const result = await serviceWith(gateway).enrich({
      ...workshopInput({ markdownContent }),
      chunks: [
        { chunkIndex: 0, startOffset: 0, endOffset: 22, metadata: {} },
        { chunkIndex: 1, startOffset: 24, endOffset: markdownContent.length, metadata: {} },
      ],
    });

    expect(result.chunks.map((chunk) => (chunk.metadata as Record<string, unknown>).dateFrom)).toEqual(["2026-12-07", "2026-12-11"]);
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-12-07", dateTo: "2026-12-11" });
  });

  it("drops a fact whose quote is not in the document and applies the rest", async () => {
    const { gateway } = scriptedGateway([{
      output: eventOutput([workshopFact(), workshopFact({ quote: "August 3, 2026", dateFrom: "2026-08-03" })]),
    }]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(result.status).toBe("applied");
    expect(result).toMatchObject({ factCount: 1, droppedFactCount: 1 });
    expect(result.provenance).toMatchObject({ factCount: 1, droppedFactCount: 1, failureReason: null });
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
  });

  it("keeps the one placed date of a five-course list on its own chunk when the other quotes cannot be placed", async () => {
    const courses = ["Yoga: 7 dicembre", "Meditazione: 8 dicembre", "Ayurveda: 9 dicembre", "Hatha: 10 dicembre", "Kirtan: 11 dicembre"];
    const markdownContent = courses.join("\n\n");
    let offset = 0;
    const chunks = courses.map((course, chunkIndex) => {
      const chunk = { chunkIndex, startOffset: offset, endOffset: offset + course.length, metadata: {} };
      offset += course.length + 2;
      return chunk;
    });
    const { gateway } = scriptedGateway([{
      output: eventOutput([
        workshopFact({ quote: "Yoga il 7/12", dateFrom: "2026-12-07", dateTo: null }),
        workshopFact({ quote: "Meditazione l'8/12", dateFrom: "2026-12-08", dateTo: null }),
        workshopFact({ quote: "Ayurveda: 9 dicembre", dateFrom: "2026-12-09", dateTo: null }),
        workshopFact({ quote: "Hatha: 10 dicembre", dateFrom: "2026-02-30", dateTo: null }),
        workshopFact({ quote: "Kirtan l'11/12", dateFrom: "2026-12-11", dateTo: null }),
      ]),
    }]);

    const result = await serviceWith(gateway).enrich({ ...workshopInput({ markdownContent }), chunks });

    expect(result.provenance).toMatchObject({ factCount: 1, droppedFactCount: 4 });
    expect(result.chunks.map((chunk) => (chunk.metadata as Record<string, unknown>).dateFrom ?? null)).toEqual([
      null,
      null,
      "2026-12-09",
      null,
      null,
    ]);
  });

  it("drops an invalid fact instead of failing the document", async () => {
    const { gateway } = scriptedGateway([{
      output: eventOutput([
        workshopFact({ quote: "Summer workshop", dateFrom: "2026-02-31" }),
        workshopFact({ quote: "Dates", dateFrom: "2026-07-20", dateTo: "2026-07-19" }),
        // Neither a date nor unresolved text: the model saying "nothing here", ignored uncounted.
        workshopFact({ quote: "Dates", dateFrom: null, unresolvedText: null }),
        workshopFact(),
      ]),
    }]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(result.status).toBe("applied");
    expect(result.provenance).toMatchObject({ factCount: 1, droppedFactCount: 2 });
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
  });

  it("dates the whole document from a date quoted only in its title", async () => {
    const { gateway } = scriptedGateway([{
      output: eventOutput([workshopFact({ quote: "17–19 luglio 2026" })]),
    }]);

    const result = await serviceWith(gateway).enrich(workshopInput({
      title: "Corso estivo — 17–19 luglio 2026",
      markdownContent: "Corso estivo\n\nTre giorni di pratica all'aperto.",
    }));

    expect(result.status).toBe("applied");
    expect(result.provenance).toMatchObject({ factCount: 1, droppedFactCount: 0 });
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    for (const chunk of result.chunks) {
      expect(chunk.metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    }
  });

  it("does not place a fact quoted from the created-at line of the representation", async () => {
    const createdAtQuote = {
      output: { type: "article", confidence: 0.9, facts: [workshopFact({ kind: "article_date", quote: "2026-07-01T00:00:00.000Z", dateFrom: "2026-07-01", dateTo: null })] },
    };
    const { gateway } = scriptedGateway([createdAtQuote, createdAtQuote]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(result.provenance).toMatchObject({ status: "failed", failureReason: "invalid_output: no_usable_facts" });
    expect(result.documentMetadata).not.toHaveProperty("dateFrom");
  });

  const previouslyDated = () => ({
    ...workshopInput(),
    document: { ...workshopInput().document, metadata: { dateFrom: "2026-07-17", dateTo: "2026-07-19", audience: "staff" } },
    previousProvenance: {
      status: "applied" as const,
      shape: "event" as const,
      matchedTypeKey: "event",
      generatedKeys: ["dateFrom", "dateTo"],
      dateOwnershipRecorded: true,
    },
  });

  it("asks again when a dated reply has facts but none it can use, then fails without touching tags", async () => {
    const unplaceable = { output: eventOutput([workshopFact({ quote: "August 3, 2026" }), workshopFact({ dateFrom: "2026-02-30" })]) };
    const { gateway, requests } = scriptedGateway([unplaceable, unplaceable]);

    const result = await serviceWith(gateway).enrich(previouslyDated());

    expect(requests.map((request) => request.retry)).toEqual([undefined, { after: "unreadable" }]);
    expect(result).toMatchObject({ status: "failed", modelAttemptCount: 2, firstAttemptFailureReason: "invalid_output: no_usable_facts" });
    expect(result.provenance.failureReason).toBe("invalid_output: no_usable_facts");
    expect(result.documentMetadata).toEqual({ dateFrom: "2026-07-17", dateTo: "2026-07-19", audience: "staff" });
    expect(result.provenance.generatedKeys).toEqual(["dateFrom", "dateTo"]);
  });

  it("applies the retry when it brings a fact it can use", async () => {
    const { gateway } = scriptedGateway([
      { output: eventOutput([workshopFact({ quote: "August 3, 2026" })]) },
      { output: eventOutput([workshopFact()]) },
    ]);

    const result = await serviceWith(gateway).enrich(previouslyDated());

    expect(result).toMatchObject({ status: "applied", modelAttemptCount: 2, droppedFactCount: 0 });
    expect(result.firstAttemptFailureReason).toBe("invalid_output: no_usable_facts");
  });

  it("asks again when the facts are prose instead of a list", async () => {
    const { gateway, requests } = scriptedGateway([
      { output: { type: "event", confidence: 0.9, facts: "Dates: July 17-19, 2026." } },
      { output: eventOutput([workshopFact()]) },
    ]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ status: "applied", firstAttemptFailureReason: "invalid_output: no_usable_facts" });
  });

  it("applies a reply for a type that writes no dates even when its stray facts cannot be placed", async () => {
    const { gateway, requests } = scriptedGateway([
      { output: { type: "profile", confidence: 0.9, facts: [workshopFact({ quote: "August 3, 2026" })] } },
    ]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "applied", droppedFactCount: 1 });
  });

  it("asks once more after an unreadable reply and applies the second", async () => {
    const { gateway, requests } = scriptedGateway([
      { error: new EnrichmentReplyUnreadableError("empty") },
      { output: eventOutput([workshopFact()]) },
    ]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(2);
    expect(requests[1]?.retry).toEqual({ after: "unreadable" });
    expect(result.status).toBe("applied");
    expect(result).toMatchObject({ modelAttemptCount: 2, firstAttemptFailureReason: "invalid_output: empty" });
  });

  it("tells the retry that the first reply was cut off at the output limit", async () => {
    const { gateway, requests } = scriptedGateway([
      { error: new EnrichmentReplyUnreadableError("truncated") },
      { output: eventOutput([workshopFact()]) },
    ]);

    await serviceWith(gateway).enrich(workshopInput());

    expect(requests[1]?.retry).toEqual({ after: "truncated" });
  });

  it("retries a reply that does not match the output schema, then fails with a content-free reason", async () => {
    const { gateway, requests } = scriptedGateway([
      { output: ["not", "an", "object"] },
      { output: "Dates: July 17-19, 2026." },
    ]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(2);
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ modelAttemptCount: 2, firstAttemptFailureReason: "invalid_output: root" });
    expect(result.provenance.failureReason).toBe("invalid_output: root");
    expect(result.provenance.failureReason).not.toContain("July");
  });

  it("stops after one retry when every reply is unreadable", async () => {
    const { gateway, requests } = scriptedGateway([
      { error: new EnrichmentReplyUnreadableError("truncated") },
      { error: new EnrichmentReplyUnreadableError("truncated") },
      { output: eventOutput([workshopFact()]) },
    ]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(2);
    expect(result.status).toBe("failed");
    expect(result.provenance.failureReason).toBe("invalid_output: truncated");
    expect(result.documentMetadata).toEqual({});
  });

  it("leaves provider errors to the adapter's own retries and fails without asking again", async () => {
    const { gateway, requests } = scriptedGateway([
      { error: new EnrichmentProviderError({ cause: new Error("503") }) },
      { output: eventOutput([workshopFact()]) },
    ]);

    const result = await serviceWith(gateway).enrich(workshopInput());

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "failed", modelAttemptCount: 1, firstAttemptFailureReason: null });
    expect(result.provenance.failureReason).toBe("provider_error");
  });

  it("makes no request when the catalog renders past its prompt budget", async () => {
    const generate = vi.fn();
    const service = serviceWith({ generate });

    const result = await service.enrich({
      ...workshopInput(),
      catalog: {
        revision: "9",
        types: [{
          key: "oversized",
          label: "Oversized",
          description: "d".repeat(13_000),
          enabled: true,
          origin: "operator",
          payload: "fields",
          disableable: true,
          fields: [],
        }],
      },
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.modelAttemptCount).toBe(0);
    expect(result.provenance.failureReason).toBe("catalog_over_budget");
  });
});

describe("DocumentEnrichmentService run outcome", () => {
  const outcomeOf = async (replies: Reply[], input = workshopInput()) => {
    const { gateway } = scriptedGateway(replies);
    return serviceWith(gateway).enrich(input);
  };

  it("codes each way a run ends, content-free", async () => {
    const truncated = { error: new EnrichmentReplyUnreadableError("truncated") };
    const usable = { output: eventOutput([workshopFact()]) };

    expect((await outcomeOf([usable])).outcome).toBe("applied");
    expect((await outcomeOf([{ error: new EnrichmentReplyUnreadableError("not_json") }, usable])).outcome).toBe("applied");
    expect((await outcomeOf([truncated, usable])).outcome).toBe("applied_after_truncation");
    expect((await outcomeOf([truncated, truncated])).outcome).toBe("truncated");
    expect((await outcomeOf([{ output: ["not", "an", "object"] }, { output: "prose" }])).outcome).toBe("invalid_output");
    expect((await outcomeOf([{ error: new EnrichmentProviderError() }])).outcome).toBe("provider_error");
  });

  it("stores nothing from a reply cut off at the output cap twice, and says so", async () => {
    const truncated = { error: new EnrichmentReplyUnreadableError("truncated") };
    const input = {
      ...workshopInput(),
      document: { ...workshopInput().document, metadata: { dateFrom: "2026-07-17", dateTo: "2026-07-19" } },
    };

    const result = await outcomeOf([truncated, truncated], input);

    expect(result).toMatchObject({ status: "failed", outcome: "truncated", factCount: 0, appliedChunkCount: 0 });
    expect(result.documentMetadata).toEqual({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    expect(result.chunks).toEqual(input.chunks);
  });

  it("codes a catalog over its prompt budget without asking the model", async () => {
    const result = await serviceWith({ generate: vi.fn() }).enrich({
      ...workshopInput(),
      catalog: {
        revision: "9",
        types: [{
          key: "oversized",
          label: "Oversized",
          description: "d".repeat(13_000),
          enabled: true,
          origin: "operator",
          payload: "fields",
          disableable: true,
          fields: [],
        }],
      },
    });

    expect(result.outcome).toBe("catalog_over_budget");
  });
});
