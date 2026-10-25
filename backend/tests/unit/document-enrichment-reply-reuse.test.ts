import { describe, expect, it, vi } from "vitest";

import { builtInDocumentTypes } from "../../src/modules/documentTypes/domain/builtInDocumentTypes.js";
import type {
  DocumentEnrichmentGateway,
  DocumentEnrichmentRequest,
} from "../../src/modules/documents/domain/enrichment/enrichmentGateway.js";
import {
  fingerprintEnrichmentRequest,
  type EnrichmentReplyStore,
  type StoredEnrichmentReply,
} from "../../src/modules/documents/domain/enrichment/enrichmentReplyStore.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import { DocumentEnrichmentService } from "../../src/modules/documents/services/documentEnrichmentService.js";

const WORKSHOP = "Summer workshop\n\nDates: July 17-19, 2026.";
const WORKSHOP_FACT = {
  kind: "event_date",
  quote: "July 17-19, 2026",
  dateFrom: "2026-07-17",
  dateTo: "2026-07-19",
  unresolvedText: null,
};
const EVENT_REPLY = { type: "event", confidence: 0.91, facts: [WORKSHOP_FACT] };

/** A gateway that answers every request with `output` and counts them. */
const countingGateway = (output: unknown = EVENT_REPLY, requestProfile = "profile-1") => {
  const requests: DocumentEnrichmentRequest[] = [];
  const gateway: DocumentEnrichmentGateway = {
    requestProfile,
    async generate(request) {
      requests.push(request);
      return { model: "gpt-5.4-mini", output };
    },
  };
  return { gateway, requests };
};

/** One stored reply per document, as the documents table holds it. */
class InMemoryReplyStore implements EnrichmentReplyStore {
  readonly replies = new Map<string, StoredEnrichmentReply>();
  saves = 0;
  clears = 0;

  async find(document: { workspaceId: string; documentId: string }): Promise<StoredEnrichmentReply | null> {
    return this.replies.get(`${document.workspaceId}:${document.documentId}`) ?? null;
  }

  async save(document: { workspaceId: string; documentId: string }, reply: StoredEnrichmentReply): Promise<void> {
    this.saves += 1;
    this.replies.set(`${document.workspaceId}:${document.documentId}`, reply);
  }

  async clear(document: { workspaceId: string; documentId: string }): Promise<void> {
    this.clears += 1;
    this.replies.delete(`${document.workspaceId}:${document.documentId}`);
  }
}

const serviceWith = (
  gateway: DocumentEnrichmentGateway,
  replyStore: EnrichmentReplyStore,
  options: { prompt?: string; logger?: { warn: (...args: unknown[]) => void } } = {},
) =>
  new DocumentEnrichmentService({
    gateway,
    replyStore,
    strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
    now: () => new Date("2026-07-02T12:00:00.000Z"),
    ...options,
  });

const workshopInput = (overrides: {
  revision?: number;
  refreshReply?: boolean;
  markdownContent?: string;
  metadata?: Record<string, unknown>;
  chunks?: Array<{ chunkIndex: number; startOffset: number; endOffset: number; metadata: Record<string, unknown> }>;
} = {}) => {
  const markdownContent = overrides.markdownContent ?? WORKSHOP;
  return {
    document: {
      id: "doc-1",
      workspaceId: "workspace-1",
      revision: overrides.revision ?? 7,
      title: "Summer workshop",
      markdownContent,
      metadata: overrides.metadata ?? {},
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    chunks: overrides.chunks ?? [
      { chunkIndex: 0, startOffset: 0, endOffset: 15, metadata: {} },
      { chunkIndex: 1, startOffset: 17, endOffset: markdownContent.length, metadata: {} },
    ],
    anchor: { source: "document_created_at" as const, date: "2026-07-01" },
    ...(overrides.refreshReply ? { refreshReply: true } : {}),
  };
};

describe("enrichment request fingerprint", () => {
  const request = (overrides: Partial<DocumentEnrichmentRequest> = {}): DocumentEnrichmentRequest => ({
    workspaceId: "workspace-1",
    documentId: "doc-1",
    documentRevision: 7,
    prompt: "Classify the document.",
    documentRepresentation: "Title: Summer workshop\n\nBody",
    outputSchema: { type: "object", properties: { type: { type: "string" }, confidence: { type: "number" } } },
    ...overrides,
  });

  it("names what the model is asked, not which revision asks it", () => {
    expect(fingerprintEnrichmentRequest(request({ documentRevision: 8 }), "profile-1")).toBe(fingerprintEnrichmentRequest(request(), "profile-1"));
    expect(fingerprintEnrichmentRequest(request({
      outputSchema: { properties: { confidence: { type: "number" }, type: { type: "string" } }, type: "object" },
    }), "profile-1")).toBe(fingerprintEnrichmentRequest(request(), "profile-1"));
  });

  it("changes with the prompt, the document representation, the output schema, or the request settings", () => {
    const original = fingerprintEnrichmentRequest(request(), "profile-1");

    expect(fingerprintEnrichmentRequest(request({ prompt: "Classify the document carefully." }), "profile-1")).not.toBe(original);
    expect(fingerprintEnrichmentRequest(request({ documentRepresentation: "Title: Summer workshop\n\nBody edited" }), "profile-1")).not.toBe(original);
    expect(fingerprintEnrichmentRequest(request({ outputSchema: { type: "object", properties: {} } }), "profile-1")).not.toBe(original);
    expect(fingerprintEnrichmentRequest(request(), "profile-2")).not.toBe(original);
  });
});

describe("DocumentEnrichmentService reply reuse", () => {
  it("stores a usable reply under the fingerprint of the request it answered", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();

    await serviceWith(gateway, store).enrich(workshopInput());

    const stored = await store.find({ workspaceId: "workspace-1", documentId: "doc-1" });
    expect(stored).toEqual({
      requestFingerprint: fingerprintEnrichmentRequest(requests[0], "profile-1"),
      model: "gpt-5.4-mini",
      output: EVENT_REPLY,
    });
  });

  it("applies the stored reply to a new revision of unchanged content without asking the model", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();
    await serviceWith(gateway, store).enrich(workshopInput());

    // Re-chunked differently: the stored facts are placed against the new chunks.
    const result = await serviceWith(gateway, store).enrich(workshopInput({
      revision: 8,
      chunks: [
        { chunkIndex: 0, startOffset: 0, endOffset: 17, metadata: {} },
        { chunkIndex: 1, startOffset: 17, endOffset: 24, metadata: {} },
        { chunkIndex: 2, startOffset: 24, endOffset: WORKSHOP.length, metadata: {} },
      ],
    }));

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "applied", outcome: "reused", modelAttemptCount: 0, factCount: 1 });
    expect(result.provenance).toMatchObject({ status: "applied", model: "gpt-5.4-mini", matchedTypeKey: "event", reusedReply: true });
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
    expect(result.chunks.map((chunk) => chunk.metadata)).toEqual([
      expect.objectContaining({ dateFrom: "2026-07-17", dateTo: "2026-07-19" }),
      expect.objectContaining({ dateFrom: "2026-07-17", dateTo: "2026-07-19" }),
      expect.objectContaining({ dateFrom: "2026-07-17", dateTo: "2026-07-19" }),
    ]);
    expect(store.saves).toBe(1);
  });

  it("applies the ownership rules to the stored reply, so dates the operator wrote since still win", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();
    await serviceWith(gateway, store).enrich(workshopInput());

    const result = await serviceWith(gateway, store).enrich(workshopInput({
      revision: 8,
      metadata: { dateFrom: "2026-07-20", dateTo: "2026-07-21" },
    }));

    expect(requests).toHaveLength(1);
    expect(result.outcome).toBe("reused");
    expect(result.documentMetadata).toMatchObject({ dateFrom: "2026-07-20", dateTo: "2026-07-21" });
    expect(result.provenance.fieldCounts).toMatchObject({ skippedCollision: 2 });
  });

  it("asks the model again when the content changed", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();
    await serviceWith(gateway, store).enrich(workshopInput());

    const result = await serviceWith(gateway, store).enrich(workshopInput({
      revision: 8,
      markdownContent: "Summer workshop\n\nDates: July 17-19, 2026. Bring water.",
    }));

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ outcome: "applied", modelAttemptCount: 1 });
    expect(result.provenance.reusedReply).toBe(false);
    expect(store.saves).toBe(2);
  });

  it("asks the model again when the prompt changed", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();
    await serviceWith(gateway, store, { prompt: "Classify: {{documentTypeKeys}}\n\n{{documentTypeCatalog}}" }).enrich(workshopInput());

    await serviceWith(gateway, store, { prompt: "Classify the document: {{documentTypeKeys}}\n\n{{documentTypeCatalog}}" }).enrich(
      workshopInput({ revision: 8 }),
    );

    expect(requests).toHaveLength(2);
  });

  it("asks the model again when the gateway's request settings changed", async () => {
    const store = new InMemoryReplyStore();
    const before = countingGateway(EVENT_REPLY, "low effort, 2000 tokens");
    await serviceWith(before.gateway, store).enrich(workshopInput());

    const after = countingGateway(EVENT_REPLY, "minimal effort, 2000 tokens");
    const result = await serviceWith(after.gateway, store).enrich(workshopInput({ revision: 8 }));

    expect(after.requests).toHaveLength(1);
    expect(result.outcome).toBe("applied");
  });

  it("asks the model afresh when the run asks for a refresh, and replaces the stored reply", async () => {
    const store = new InMemoryReplyStore();
    await serviceWith(countingGateway().gateway, store).enrich(workshopInput());
    const refreshed = { ...EVENT_REPLY, confidence: 0.97 };
    const { gateway, requests } = countingGateway(refreshed);

    const result = await serviceWith(gateway, store).enrich(workshopInput({ revision: 8, refreshReply: true }));

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "applied", outcome: "applied", modelAttemptCount: 1 });
    expect(result.provenance.reusedReply).toBe(false);
    expect((await store.find({ workspaceId: "workspace-1", documentId: "doc-1" }))?.output).toEqual(refreshed);
  });

  it("asks the model again when the enabled catalog changed", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();
    await serviceWith(gateway, store).enrich(workshopInput());

    await serviceWith(gateway, store).enrich({
      ...workshopInput({ revision: 8 }),
      catalog: { revision: "2", types: builtInDocumentTypes.filter((type) => type.key !== "profile") },
    });

    expect(requests).toHaveLength(2);
  });

  it("asks the model when the stored reply no longer reads, and replaces it", async () => {
    const store = new InMemoryReplyStore();
    const { gateway, requests } = countingGateway();
    await serviceWith(gateway, store).enrich(workshopInput());
    const stored = (await store.find({ workspaceId: "workspace-1", documentId: "doc-1" }))!;
    store.replies.set("workspace-1:doc-1", { ...stored, output: "Dates: July 17-19, 2026." });

    const result = await serviceWith(gateway, store).enrich(workshopInput({ revision: 8 }));

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ status: "applied", outcome: "applied" });
    expect((await store.find({ workspaceId: "workspace-1", documentId: "doc-1" }))?.output).toEqual(EVENT_REPLY);
  });

  it("drops a stored reply that answered other content, even when the run then fails", async () => {
    const store = new InMemoryReplyStore();
    await serviceWith(countingGateway().gateway, store).enrich(workshopInput());
    const unusable = countingGateway("not an envelope");

    const result = await serviceWith(unusable.gateway, store).enrich(workshopInput({
      revision: 8,
      markdownContent: "Summer workshop\n\nDates: July 17-19, 2026. Bring water.",
    }));

    expect(result.status).toBe("failed");
    expect(store.saves).toBe(1);
    expect(await store.find({ workspaceId: "workspace-1", documentId: "doc-1" })).toBeNull();
  });

  it("treats a store that cannot read or write as holding nothing, and warns without content", async () => {
    const failure = new TypeError("connection reset by 10.0.0.7 while reading Summer workshop");
    const failingStore: EnrichmentReplyStore = {
      async find() {
        throw failure;
      },
      async save() {
        throw failure;
      },
      async clear() {
        throw failure;
      },
    };
    const logger = { warn: vi.fn() };
    const { gateway, requests } = countingGateway();

    const result = await serviceWith(gateway, failingStore, { logger }).enrich(workshopInput());

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "applied", outcome: "applied" });
    expect(logger.warn.mock.calls).toEqual([
      [{ workspaceId: "workspace-1", documentId: "doc-1", errorClass: "TypeError" }, "Document enrichment reply could not be read"],
      [{ workspaceId: "workspace-1", documentId: "doc-1", errorClass: "TypeError" }, "Document enrichment reply could not be stored"],
    ]);
  });
});
