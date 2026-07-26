import { describe, expect, it } from "vitest";

import type {
  EmbeddingSpaceRef,
  VectorAdapter,
  VectorIndexMutation,
  VectorIndexRecord,
} from "../../src/modules/retrieval/domain/vectorAdapter.js";

export interface VectorAdapterConformanceSubject {
  adapter: VectorAdapter;
  dispose?(): Promise<void>;
}

export type VectorAdapterConformanceFactory = () => Promise<VectorAdapterConformanceSubject>;

const space: EmbeddingSpaceRef = {
  id: "space-conformance",
  dimensions: 2,
  distanceMetric: "cosine",
};

const otherSpace: EmbeddingSpaceRef = {
  id: "space-other",
  dimensions: 2,
  distanceMetric: "cosine",
};

const record = (
  chunkId: string,
  vector: number[],
  version: string,
  overrides: Partial<VectorIndexRecord> = {},
): VectorIndexRecord => ({
  chunkId,
  documentId: `document-${chunkId}`,
  vector,
  version,
  payload: {
    sourceId: null,
    metadata: {},
    retrievalEnabled: true,
    retrievalExpiresAt: null,
  },
  ...overrides,
});

const withSubject = async (
  createSubject: VectorAdapterConformanceFactory,
  callback: (adapter: VectorAdapter) => Promise<void>,
): Promise<void> => {
  const subject = await createSubject();
  try {
    await callback(subject.adapter);
  } finally {
    await subject.dispose?.();
  }
};

const apply = async (
  adapter: VectorAdapter,
  mutations: VectorIndexMutation[],
  inputSpace: EmbeddingSpaceRef = space,
  workspaceId = "workspace-1",
) => adapter.writer.applyMutations({
  workspaceId,
  space: inputSpace,
  mutations,
});

export const runVectorAdapterConformance = (
  name: string,
  createSubject: VectorAdapterConformanceFactory,
): void => {
  describe(`${name} vector adapter conformance`, () => {
    it("declares capabilities and idempotently prepares and resets logical spaces", async () => {
      await withSubject(createSubject, async (adapter) => {
        const capabilities = await adapter.capabilities.getCapabilities();
        expect(capabilities.distanceMetrics).toContain("cosine");
        expect(capabilities.filterOperations).toEqual(expect.arrayContaining([
          "source",
          "metadata_containment",
          "retrieval_eligibility",
          "expiry",
        ]));

        await adapter.admin.prepareSpace({ space });
        await adapter.admin.prepareSpace({ space });
        await apply(adapter, [{ kind: "upsert", record: record("chunk-1", [1, 0], "1") }]);

        await adapter.admin.resetSpace({ spaceId: space.id, workspaceId: "workspace-1" });
        await expect(adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 10,
          minimumScore: -1,
          filter: {},
        })).resolves.toEqual([]);
      });
    });

    it("keeps workspace and embedding-space candidates isolated", async () => {
      await withSubject(createSubject, async (adapter) => {
        await adapter.admin.prepareSpace({ space });
        await adapter.admin.prepareSpace({ space: otherSpace });
        await apply(adapter, [{ kind: "upsert", record: record("workspace-1", [1, 0], "1") }]);
        await apply(adapter, [{ kind: "upsert", record: record("workspace-2", [1, 0], "1") }], space, "workspace-2");
        await apply(adapter, [{ kind: "upsert", record: record("other-space", [1, 0], "1") }], otherSpace);

        const results = await adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 10,
          minimumScore: -1,
          filter: {},
        });

        expect(results.map((candidate) => candidate.chunkId)).toEqual(["workspace-1"]);
        expect(results[0]).toMatchObject({
          embeddingSpaceId: space.id,
          version: "1",
          score: 1,
        });
      });
    });

    it("makes duplicate and out-of-order upserts, supersessions, and tombstones safe", async () => {
      await withSubject(createSubject, async (adapter) => {
        await adapter.admin.prepareSpace({ space });
        const v2 = record("chunk-1", [1, 0], "2", {
          payload: {
            sourceId: "source-current",
            metadata: { state: "current" },
            retrievalEnabled: true,
            retrievalExpiresAt: null,
          },
        });
        const staleV1 = record("chunk-1", [-1, 0], "1", {
          payload: {
            sourceId: "source-stale",
            metadata: { state: "stale" },
            retrievalEnabled: true,
            retrievalExpiresAt: null,
          },
        });

        await apply(adapter, [{ kind: "upsert", record: v2 }]);
        await apply(adapter, [{ kind: "upsert", record: v2 }]);
        await apply(adapter, [{ kind: "upsert", record: staleV1 }]);
        await apply(adapter, [{
          kind: "delete",
          chunkId: "chunk-1",
          version: "3",
        }]);
        await apply(adapter, [{ kind: "upsert", record: v2 }]);
        await apply(adapter, [{
          kind: "delete",
          chunkId: "deleted-before-upsert",
          version: "5",
        }]);
        await apply(adapter, [{
          kind: "upsert",
          record: record("deleted-before-upsert", [1, 0], "4"),
        }]);

        await expect(adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 10,
          minimumScore: -1,
          filter: {},
        })).resolves.toEqual([]);
      });
    });

    it("applies current filter payloads before topK and returns complete deterministic ties", async () => {
      await withSubject(createSubject, async (adapter) => {
        await adapter.admin.prepareSpace({ space });
        await apply(adapter, [
          {
            kind: "upsert",
            record: record("chunk-b", [1, 0], "1", {
              payload: {
                sourceId: null,
                metadata: { customer: { id: "acme", tags: ["priority", "support"] } },
                retrievalEnabled: true,
                retrievalExpiresAt: "2026-07-27T00:00:00.000Z",
              },
            }),
          },
          {
            kind: "upsert",
            record: record("chunk-a", [1, 0], "1", {
              payload: {
                sourceId: "source-1",
                metadata: { customer: { id: "acme", tags: ["priority"] } },
                retrievalEnabled: true,
                retrievalExpiresAt: null,
              },
            }),
          },
          {
            kind: "upsert",
            record: record("chunk-disabled", [1, 0], "1", {
              payload: {
                sourceId: "source-1",
                metadata: { customer: { id: "acme", tags: ["priority"] } },
                retrievalEnabled: false,
                retrievalExpiresAt: null,
              },
            }),
          },
          {
            kind: "upsert",
            record: record("chunk-expired", [1, 0], "1", {
              payload: {
                sourceId: "source-1",
                metadata: { customer: { id: "acme", tags: ["priority"] } },
                retrievalEnabled: true,
                retrievalExpiresAt: "2026-07-26T00:00:00.000Z",
              },
            }),
          },
        ]);

        const assigned = await adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 2,
          minimumScore: 1,
          filter: {
            source: {
              constrained: true,
              sourceIds: ["source-1"],
              includeUnassignedDocuments: false,
            },
            metadataContains: {
              customer: {
                id: "acme",
                tags: ["priority"],
              },
            },
            retrievalEnabled: true,
            notExpiredAt: "2026-07-26T12:00:00.000Z",
          },
        });
        expect(assigned.map((candidate) => candidate.chunkId)).toEqual(["chunk-a"]);

        const allCurrent = await adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 2,
          minimumScore: 1,
          filter: {
            source: { constrained: false },
            retrievalEnabled: true,
            notExpiredAt: "2026-07-26T12:00:00.000Z",
          },
        });
        expect(allCurrent.map((candidate) => candidate.chunkId)).toEqual(["chunk-a", "chunk-b"]);
      });
    });

    it("updates projected filters by version without leaving stale candidates", async () => {
      await withSubject(createSubject, async (adapter) => {
        await adapter.admin.prepareSpace({ space });
        await apply(adapter, [{
          kind: "upsert",
          record: record("chunk-1", [1, 0], "1", {
            payload: {
              sourceId: "source-1",
              metadata: { state: "old" },
              retrievalEnabled: true,
              retrievalExpiresAt: null,
            },
          }),
        }]);
        await apply(adapter, [{
          kind: "upsert",
          record: record("chunk-1", [1, 0], "2", {
            payload: {
              sourceId: "source-2",
              metadata: { state: "new" },
              retrievalEnabled: true,
              retrievalExpiresAt: null,
            },
          }),
        }]);

        const stale = await adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 10,
          minimumScore: -1,
          filter: { metadataContains: { state: "old" } },
        });
        const current = await adapter.search.search({
          workspaceId: "workspace-1",
          space,
          queryVector: [1, 0],
          topK: 10,
          minimumScore: -1,
          filter: { metadataContains: { state: "new" } },
        });

        expect(stale).toEqual([]);
        expect(current).toHaveLength(1);
        expect(current[0]).toMatchObject({ chunkId: "chunk-1", version: "2" });
      });
    });

    it("reports backend and prepared-space readiness", async () => {
      await withSubject(createSubject, async (adapter) => {
        await expect(adapter.admin.getHealth({ spaceId: space.id })).resolves.toMatchObject({
          backend: expect.any(String),
          status: "unavailable",
          readiness: "unavailable",
        });

        await adapter.admin.prepareSpace({ space });

        await expect(adapter.admin.getHealth({ spaceId: space.id })).resolves.toMatchObject({
          backend: expect.any(String),
          status: "available",
          readiness: "ready",
        });
      });
    });
  });
};
