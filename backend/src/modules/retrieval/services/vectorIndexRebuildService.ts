import type {
  EmbeddingSpaceRef,
  VectorAdapter,
  VectorIndexRecord,
} from "../domain/vectorAdapter.js";

export type VectorIndexRebuildScope =
  | { kind: "document"; workspaceId: string; documentId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "space"; embeddingSpaceId: string; workspaceId?: string }
  | { kind: "deployment" };

export interface CanonicalVectorRebuildRecord {
  workspaceId: string;
  space: EmbeddingSpaceRef;
  record: VectorIndexRecord;
}

export interface CanonicalVectorRebuildSourcePort {
  listTargets(scope: VectorIndexRebuildScope): Promise<Array<{
    workspaceId: string;
    space: EmbeddingSpaceRef;
  }>>;
  scan(input: {
    scope: VectorIndexRebuildScope;
    cursor: string | null;
    limit: number;
  }): Promise<{
    records: CanonicalVectorRebuildRecord[];
    nextCursor: string | null;
  }>;
  applyIfCurrent(input: {
    item: CanonicalVectorRebuildRecord;
    apply(current: CanonicalVectorRebuildRecord): Promise<void>;
  }): Promise<boolean>;
}

export class VectorIndexRebuildService {
  constructor(private readonly options: {
    adapter: VectorAdapter;
    source: CanonicalVectorRebuildSourcePort;
    batchSize: number;
  }) {}

  async rebuild(input: {
    scope: VectorIndexRebuildScope;
    generation: string;
  }): Promise<{
    recordsWritten: number;
    spacesPrepared: number;
  }> {
    assertGeneration(input.generation);
    let cursor: string | null = null;
    let recordsWritten = 0;
    const prepared = new Set<string>();
    const targets = await this.options.source.listTargets(input.scope);
    for (const target of targets) {
      assertTargetInScope(target, input.scope);
      const key = `${target.space.id}\u0000${target.workspaceId}`;
      await this.options.adapter.admin.prepareSpace({ space: target.space });
      if (input.scope.kind !== "document") {
        await this.options.adapter.admin.resetSpace({
          spaceId: target.space.id,
          workspaceId: target.workspaceId,
        });
        await this.options.adapter.admin.prepareSpace({ space: target.space });
      }
      prepared.add(key);
    }
    do {
      const page = await this.options.source.scan({
        scope: input.scope,
        cursor,
        limit: this.options.batchSize,
      });
      for (const item of page.records) {
        assertInScope(item, input.scope);
        const key = `${item.space.id}\u0000${item.workspaceId}`;
        if (!prepared.has(key)) {
          await this.options.adapter.admin.prepareSpace({ space: item.space });
          prepared.add(key);
        }
        const applied = await this.options.source.applyIfCurrent({
          item,
          apply: (current) => {
            assertInScope(current, input.scope);
            return this.options.adapter.writer.applyMutations({
              workspaceId: current.workspaceId,
              space: current.space,
              mutations: [{ kind: "upsert", record: current.record }],
            }).then(() => undefined);
          },
        });
        if (applied) {
          recordsWritten += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return {
      recordsWritten,
      spacesPrepared: prepared.size,
    };
  }
}

const assertGeneration = (generation: string): void => {
  if (!/^[1-9]\d*$/.test(generation)) {
    throw new Error("Vector rebuild generation must be a positive decimal integer");
  }
};

const assertInScope = (
  item: CanonicalVectorRebuildRecord,
  scope: VectorIndexRebuildScope,
): void => {
  if (
    (scope.kind === "document"
      && (
        item.workspaceId !== scope.workspaceId
        || item.record.documentId !== scope.documentId
      ))
    || (scope.kind === "workspace" && item.workspaceId !== scope.workspaceId)
    || (
      scope.kind === "space"
      && (
        item.space.id !== scope.embeddingSpaceId
        || (
          scope.workspaceId !== undefined
          && item.workspaceId !== scope.workspaceId
        )
      )
    )
  ) {
    throw new Error("Canonical rebuild source returned an out-of-scope vector");
  }
};

const assertTargetInScope = (
  target: { workspaceId: string; space: EmbeddingSpaceRef },
  scope: VectorIndexRebuildScope,
): void => {
  if (
    (scope.kind === "document" && target.workspaceId !== scope.workspaceId)
    || (scope.kind === "workspace" && target.workspaceId !== scope.workspaceId)
    || (
      scope.kind === "space"
      && (
        target.space.id !== scope.embeddingSpaceId
        || (
          scope.workspaceId !== undefined
          && target.workspaceId !== scope.workspaceId
        )
      )
    )
  ) {
    throw new Error("Canonical rebuild source returned an out-of-scope target");
  }
};
