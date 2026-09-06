import { describe, expect, it, vi } from "vitest";

import type { DocumentProcessingJobRecord } from "../../../src/db/repositories/documentProcessingJobRepository.js";
import type { PinnedDocumentEmbeddingPort } from "../../../src/modules/embeddingProfiles/contracts/embeddingConsumers.js";
import {
  EmbeddingProfileJobService,
  type EmbeddingProfileJobPersistencePort,
} from "../../../src/modules/documents/services/embeddingProfileJobService.js";

const embeddingProfileJob = (
  overrides: Partial<DocumentProcessingJobRecord> = {},
): DocumentProcessingJobRecord => ({
  id: "job-profile",
  documentId: "document-1",
  workspaceId: "workspace-1",
  documentRevision: 7,
  kind: "embedding_profile",
  embeddingSpaceId: "space-pending",
  workspaceProfileGeneration: "4",
  status: "processing",
  attemptCount: 1,
  lastError: null,
  availableAt: new Date("2026-07-26T10:00:00Z"),
  claimedAt: new Date("2026-07-26T10:00:01Z"),
  completedAt: null,
  createdAt: new Date("2026-07-26T09:59:00Z"),
  updatedAt: new Date("2026-07-26T10:00:01Z"),
  options: null,
  ...overrides,
});

const chunks = [
  {
    id: "chunk-1",
    chunkIndex: 0,
    text: "First canonical search text",
  },
  {
    id: "chunk-2",
    chunkIndex: 1,
    text: "Second canonical search text",
  },
] as const;

const createEmbeddingPort = (
  calls: Array<{ embeddingSpaceId: string; texts: readonly string[] }>,
): PinnedDocumentEmbeddingPort => ({
  async embedDocumentChunksForSpace(request) {
    calls.push({
      embeddingSpaceId: request.embeddingSpaceId,
      texts: request.texts,
    });
    return {
      space: {
        id: request.embeddingSpaceId,
        dimensions: 3,
        distanceMetric: "cosine",
      },
      vectors: request.texts.map((_, index) => [index + 1, 0, 0]),
    };
  },
});

describe("EmbeddingProfileJobService", () => {
  it("processes active and pending jobs against their exact pinned spaces", async () => {
    const embeddingCalls: Array<{
      embeddingSpaceId: string;
      texts: readonly string[];
    }> = [];
    const commits: Parameters<EmbeddingProfileJobPersistencePort["commit"]>[0][] = [];
    const persistence: EmbeddingProfileJobPersistencePort = {
      async load(_input) {
        return {
          outcome: "ready",
          sourceId: null,
          chunks: chunks.map((chunk) => ({ ...chunk })),
        };
      },
      async commit(input) {
        commits.push(input);
        return "completed";
      },
    };
    const service = new EmbeddingProfileJobService(
      persistence,
      createEmbeddingPort(embeddingCalls),
    );

    await expect(
      service.process(
        embeddingProfileJob({
          id: "job-active",
          embeddingSpaceId: "space-active",
        }),
      ),
    ).resolves.toBe("completed");
    await expect(
      service.process(
        embeddingProfileJob({
          id: "job-pending",
          embeddingSpaceId: "space-pending",
        }),
      ),
    ).resolves.toBe("completed");

    expect(embeddingCalls.map((call) => call.embeddingSpaceId)).toEqual([
      "space-active",
      "space-pending",
    ]);
    expect(commits).toEqual([
      expect.objectContaining({
        jobId: "job-active",
        workspaceId: "workspace-1",
        documentId: "document-1",
        documentRevision: 7,
        embeddingSpaceId: "space-active",
        expectedWorkspaceProfileGeneration: "4",
        canonicalVersion: "7",
      }),
      expect.objectContaining({
        jobId: "job-pending",
        embeddingSpaceId: "space-pending",
        expectedWorkspaceProfileGeneration: "4",
      }),
    ]);
  });

  it.each([
    ["document_deleted", "deleted"],
    ["stale_revision", "stale"],
    ["superseded", "superseded"],
  ] as const)(
    "does not call the provider when durable work is %s",
    async (loadOutcome, expectedOutcome) => {
      const embeddings: PinnedDocumentEmbeddingPort = {
        embedDocumentChunksForSpace: vi.fn(),
      };
      const commit = vi.fn();
      const service = new EmbeddingProfileJobService(
        {
          async load() {
            return { outcome: loadOutcome };
          },
          commit,
        },
        embeddings,
      );

      await expect(service.process(embeddingProfileJob())).resolves.toBe(
        expectedOutcome,
      );
      expect(embeddings.embedDocumentChunksForSpace).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    },
  );

  it("discards a late provider completion when the generation fence changed", async () => {
    let generation = "4";
    const writes: unknown[] = [];
    const persistence: EmbeddingProfileJobPersistencePort = {
      async load() {
        return {
          outcome: "ready",
          sourceId: null,
          chunks: chunks.map((chunk) => ({ ...chunk })),
        };
      },
      async commit(input) {
        if (input.expectedWorkspaceProfileGeneration !== generation) {
          return "superseded";
        }
        writes.push(input);
        return "completed";
      },
    };
    const service = new EmbeddingProfileJobService(persistence, {
      async embedDocumentChunksForSpace(request) {
        generation = "5";
        return {
          space: {
            id: request.embeddingSpaceId,
            dimensions: 3,
            distanceMetric: "cosine",
          },
          vectors: request.texts.map(() => [1, 0, 0]),
        };
      },
    });

    await expect(service.process(embeddingProfileJob())).resolves.toBe(
      "superseded",
    );
    expect(writes).toEqual([]);
  });

  it("can retry the same pinned job after a transient provider failure", async () => {
    let attempt = 0;
    const commit = vi.fn(async () => "completed" as const);
    const service = new EmbeddingProfileJobService(
      {
        async load() {
          return {
            outcome: "ready",
            sourceId: null,
            chunks: chunks.map((chunk) => ({ ...chunk })),
          };
        },
        commit,
      },
      {
        async embedDocumentChunksForSpace(request) {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("provider temporarily unavailable");
          }
          return {
            space: {
              id: request.embeddingSpaceId,
              dimensions: 3,
              distanceMetric: "cosine",
            },
            vectors: request.texts.map(() => [1, 0, 0]),
          };
        },
      },
    );

    await expect(service.process(embeddingProfileJob())).rejects.toThrow(
      "provider temporarily unavailable",
    );
    await expect(service.process(embeddingProfileJob())).resolves.toBe(
      "completed",
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it("resumes after an acknowledged commit was lost without regenerating vectors", async () => {
    let committed = false;
    const embed = vi.fn(async (request: {
      embeddingSpaceId: string;
      texts: readonly string[];
    }) => ({
      space: {
        id: request.embeddingSpaceId,
        dimensions: 3,
        distanceMetric: "cosine" as const,
      },
      vectors: request.texts.map(() => [1, 0, 0]),
    }));
    const persistence: EmbeddingProfileJobPersistencePort = {
      async load() {
        return {
          outcome: "ready",
          sourceId: null,
          chunks: committed ? [] : chunks.map((chunk) => ({ ...chunk })),
        };
      },
      async commit() {
        committed = true;
        throw new Error("worker stopped after commit");
      },
    };
    const firstProcess = new EmbeddingProfileJobService(persistence, {
      embedDocumentChunksForSpace: embed,
    });

    await expect(firstProcess.process(embeddingProfileJob())).rejects.toThrow(
      "worker stopped after commit",
    );

    const restartedProcess = new EmbeddingProfileJobService(persistence, {
      embedDocumentChunksForSpace: embed,
    });
    await expect(restartedProcess.process(embeddingProfileJob())).resolves.toBe(
      "completed",
    );
    expect(embed).toHaveBeenCalledOnce();
  });

  it("does not expose any document, chunk, revision, status, or enrichment mutation dependency", async () => {
    const documentState = {
      revision: 7,
      status: "ready",
      enrichment: { extractedAt: "2026-07-25T00:00:00Z" },
      chunks: chunks.map((chunk) => ({ ...chunk })),
    };
    const before = structuredClone(documentState);
    const service = new EmbeddingProfileJobService(
      {
        async load() {
          return {
            outcome: "ready",
            sourceId: "source-1",
            chunks: chunks.map((chunk) => ({ ...chunk })),
          };
        },
        async commit() {
          return "completed";
        },
      },
      createEmbeddingPort([]),
    );

    await expect(service.process(embeddingProfileJob())).resolves.toBe(
      "completed",
    );
    expect(documentState).toEqual(before);
  });

  it("rejects jobs without complete immutable pins", async () => {
    const service = new EmbeddingProfileJobService(
      {
        load: vi.fn(),
        commit: vi.fn(),
      },
      {
        embedDocumentChunksForSpace: vi.fn(),
      },
    );

    await expect(
      service.process(
        embeddingProfileJob({
          embeddingSpaceId: null,
        }),
      ),
    ).rejects.toThrow(/embedding space/i);
    await expect(
      service.process(
        embeddingProfileJob({
          workspaceProfileGeneration: null,
        }),
      ),
    ).rejects.toThrow(/profile generation/i);
  });

  it("rejects vectors returned for a different target space", async () => {
    const commit = vi.fn();
    const service = new EmbeddingProfileJobService(
      {
        async load() {
          return {
            outcome: "ready",
            sourceId: null,
            chunks: chunks.map((chunk) => ({ ...chunk })),
          };
        },
        commit,
      },
      {
        async embedDocumentChunksForSpace(request) {
          return {
            space: {
              id: "space-wrong",
              dimensions: 3,
              distanceMetric: "cosine",
            },
            vectors: request.texts.map(() => [1, 0, 0]),
          };
        },
      },
    );

    await expect(service.process(embeddingProfileJob())).rejects.toThrow(
      /returned space.*space-wrong.*pinned target.*space-pending/i,
    );
    expect(commit).not.toHaveBeenCalled();
  });
});
