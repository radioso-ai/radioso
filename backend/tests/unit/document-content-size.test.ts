import { describe, expect, it, vi } from "vitest";

import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentImportService } from "../../src/modules/documents/services/documentImportService.js";
import type {
  IndexedStorageReservationInput,
  UsageLimitPolicy,
  UsageLimitReservation,
} from "../../src/shared/domain/usageLimitPolicy.js";
import {
  createAuditService,
  InMemoryDocumentProcessingJobRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentStorage,
} from "../support/fakes.js";

class RecordingUsageLimitPolicy implements UsageLimitPolicy {
  readonly indexedStorageCalls: IndexedStorageReservationInput[] = [];
  readonly storageCommits: number[] = [];
  readonly storageReleases: number[] = [];
  failIndexedStorage = false;

  async reserveAnswer(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveDocument(): Promise<UsageLimitReservation> {
    return noopReservation;
  }

  async reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation> {
    if (this.failIndexedStorage) {
      throw {
        statusCode: 429,
        code: "usage_limit_exceeded",
        message: "Indexed storage exceeded",
        details: { resource: "stored_indexed_bytes" },
      };
    }
    const callIndex = this.indexedStorageCalls.length;
    this.indexedStorageCalls.push(input);
    return {
      commit: async () => {
        this.storageCommits.push(callIndex);
      },
      release: async () => {
        this.storageReleases.push(callIndex);
      },
    };
  }

  async reserveMonthlyIndexedContent(): Promise<UsageLimitReservation> {
    return noopReservation;
  }
}

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

describe("document content size accounting", () => {
  it("reserves indexed storage with the UTF-8 byte length of sanitized inline content", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
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

    const content = "héllo wörld"; // multi-byte utf-8 characters
    const expectedBytes = Buffer.byteLength(content, "utf8");

    const response = await service.ingest({
      workspaceId: "workspace-1",
      title: "Inline doc",
      content,
    });

    expect(policy.indexedStorageCalls).toHaveLength(1);
    expect(policy.indexedStorageCalls[0]).toEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      sourceKind: "inline_text",
      contentSizeBytes: expectedBytes,
    }));
    expect(policy.storageCommits).toEqual([0]);
    expect(policy.storageReleases).toEqual([]);

    const persisted = await documentRepository.findByIdAndWorkspaceId(response.documentId, "workspace-1");
    expect(persisted?.contentSizeBytes).toBe(expectedBytes);
  });

  it("releases the storage reservation when ingest fails after reservation", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
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

    jobRepository.enqueue = async () => {
      throw new Error("queue unavailable");
    };

    await expect(
      service.ingest({
        workspaceId: "workspace-1",
        title: "Boom",
        content: "Body",
      }),
    ).rejects.toThrow("queue unavailable");

    expect(policy.indexedStorageCalls).toHaveLength(1);
    expect(policy.storageReleases).toEqual([0]);
    expect(policy.storageCommits).toEqual([]);
  });

  it("rejects ingestion when indexed storage reservation throws and does not commit the document", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const policy = new RecordingUsageLimitPolicy();
    policy.failIndexedStorage = true;
    const service = new DocumentIngestionService(
      documentRepository,
      createAuditService(),
      undefined,
      undefined,
      undefined,
      undefined,
      policy,
    );

    await expect(
      service.ingest({
        workspaceId: "workspace-1",
        title: "Over budget",
        content: "Body",
      }),
    ).rejects.toMatchObject({ code: "usage_limit_exceeded" });

    expect(await documentRepository.listByWorkspaceId("workspace-1")).toHaveLength(0);
  });

  it("imports record the stored object size as both source and content size bytes", async () => {
    const documentRepository = new InMemoryDocumentRepository();
    const jobRepository = new InMemoryDocumentProcessingJobRepository(documentRepository);
    documentRepository.setJobRepository(jobRepository);
    const policy = new RecordingUsageLimitPolicy();
    const storage = new InMemoryDocumentStorage();
    const service = new DocumentImportService(
      documentRepository,
      createAuditService(),
      storage,
      undefined,
      undefined,
      undefined,
      policy,
    );

    const buffer = Buffer.from("hello text file");
    const response = await service.importDocument({
      workspaceId: "workspace-1",
      filename: "hello.txt",
      mimeType: "text/plain",
      buffer,
    });

    expect(policy.indexedStorageCalls).toHaveLength(1);
    expect(policy.indexedStorageCalls[0]).toEqual(expect.objectContaining({
      contentSizeBytes: buffer.length,
      sourceKind: "uploaded_file",
    }));

    const persisted = await documentRepository.findByIdAndWorkspaceId(response.documentId, "workspace-1");
    expect(persisted?.sourceSizeBytes).toBe(buffer.length);
    expect(persisted?.contentSizeBytes).toBe(buffer.length);
  });
});
