import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import type {
  IndexedStorageReservationInput,
  UsageLimitPolicy,
  UsageLimitReservation,
} from "../../src/shared/domain/usageLimitPolicy.js";
import {
  createAuditService,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
} from "../support/fakes.js";

class RecordingUsageLimitPolicy implements UsageLimitPolicy {
  readonly indexedStorageCalls: IndexedStorageReservationInput[] = [];

  async reserveAnswer(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveDocument(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation> {
    this.indexedStorageCalls.push(input);
    return noopReservation;
  }
}

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const seedInlineDocument = async (
  documentRepository: InMemoryDocumentRepository,
  jobRepository: InMemoryDocumentProcessingJobRepository,
  input: { workspaceId: string; externalDocumentId: string; content: string },
) => {
  documentRepository.setJobRepository(jobRepository);
  const policy = new RecordingUsageLimitPolicy();
  const service = new DocumentIngestionService(
    documentRepository,
    createAuditService(),
    undefined,
    undefined,
    undefined,
    undefined,
    policy,
  );

  await service.ingest({
    workspaceId: input.workspaceId,
    title: "Initial",
    content: input.content,
    externalDocumentId: input.externalDocumentId,
  });
  return policy;
};

describe("document recrawl accounting", () => {
  it("persists a normalized content hash on each ingest", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      new RecordingUsageLimitPolicy(),
    );

    const content = "Recrawl me";
    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Page",
      content,
      externalDocumentId: "page-1",
    });

    const persisted = await documentRepository.findByIdAndWorkspaceId(response.documentId, "workspace-1");
    expect(persisted?.contentHash).toBe(sha256Hex(content));
  });

  it("skips re-queueing when a recrawl returns the same scoped content hash", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    const enqueueSpy = vi.spyOn(jobRepository, "enqueue");
    await seedInlineDocument(documentRepository, jobRepository, {
      workspaceId: "workspace-1",
      externalDocumentId: "page-1",
      content: "Same body",
    });
    const initialJobCount = enqueueSpy.mock.calls.length;
    const policy = new RecordingUsageLimitPolicy();
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      policy,
    );

    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Recrawl",
      content: "Same body",
      externalDocumentId: "page-1",
    });

    expect(response.status).toBe("ready");
    expect(enqueueSpy).toHaveBeenCalledTimes(initialJobCount);
    expect(policy.indexedStorageCalls).toHaveLength(0);
  });

  it("reserves only the positive byte delta when recrawled content grows", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    await seedInlineDocument(documentRepository, jobRepository, {
      workspaceId: "workspace-1",
      externalDocumentId: "page-2",
      content: "short",
    });
    const initialBytes = Buffer.byteLength("short", "utf8");
    const newContent = "much longer body for the recrawl";
    const newBytes = Buffer.byteLength(newContent, "utf8");
    const policy = new RecordingUsageLimitPolicy();
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      policy,
    );

    await service.ingest({
      workspaceId: "workspace-1",
      title: "Recrawl",
      content: newContent,
      externalDocumentId: "page-2",
    });

    expect(policy.indexedStorageCalls).toHaveLength(1);
    expect(policy.indexedStorageCalls[0].contentSizeBytes).toBe(newBytes - initialBytes);
  });

  it("reserves zero bytes when a recrawl shrinks the existing page", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    await seedInlineDocument(documentRepository, jobRepository, {
      workspaceId: "workspace-1",
      externalDocumentId: "page-3",
      content: "this is a fairly long initial body for the page",
    });
    const policy = new RecordingUsageLimitPolicy();
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      policy,
    );

    await service.ingest({
      workspaceId: "workspace-1",
      title: "Recrawl",
      content: "shorter",
      externalDocumentId: "page-3",
    });

    expect(policy.indexedStorageCalls).toHaveLength(1);
    expect(policy.indexedStorageCalls[0].contentSizeBytes).toBe(0);
  });

  it("deletes pages whose external ids are missing from a full crawl reap", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const sourceId = "source-1";
    const keep = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Keep one",
      sourceContent: "alpha",
      markdownContent: "alpha",
      sourceKind: "inline_text",
      sourceId,
      externalDocumentId: "keep-1",
      contentSizeBytes: 5,
      status: "ready",
    });
    const drop = await documentRepository.create({
      workspaceId: "workspace-1",
      title: "Drop",
      sourceContent: "beta",
      markdownContent: "beta",
      sourceKind: "inline_text",
      sourceId,
      externalDocumentId: "drop-1",
      contentSizeBytes: 4,
      status: "ready",
    });
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      new RecordingUsageLimitPolicy(),
    );

    const result = await service.reapMissingPages({
      workspaceId: "workspace-1",
      sourceId,
      keepExternalDocumentIds: ["keep-1"],
    });

    expect(result.deletedCount).toBe(1);
    expect(result.deletedContentBytes).toBe(4);
    expect(await documentRepository.findByIdAndWorkspaceId(drop.id, "workspace-1")).toBeNull();
    expect(await documentRepository.findByIdAndWorkspaceId(keep.id, "workspace-1")).not.toBeNull();
  });
});
