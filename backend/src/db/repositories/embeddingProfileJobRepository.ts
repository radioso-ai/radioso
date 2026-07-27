import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  EmbeddingProfileJobCommitInput,
  EmbeddingProfileJobLoadInput,
  EmbeddingProfileJobLoadResult,
  EmbeddingProfileJobPersistencePort,
} from "../../modules/documents/services/embeddingProfileJobService.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import { upsertCanonicalChunkEmbeddingWithProjection } from "./chunkEmbeddingRepository.js";
import { vectorProjectionMutationFenceKey } from "./vectorIndexWorkRepository.js";

export class EmbeddingProfileJobRepository
implements EmbeddingProfileJobPersistencePort {
  constructor(private readonly db: Db) {}

  async load(
    input: EmbeddingProfileJobLoadInput,
  ): Promise<EmbeddingProfileJobLoadResult> {
    const fence = await this.readFence(this.db, input);
    if (fence !== "ready") {
      return { outcome: fence };
    }

    const document = await this.db
      .selectFrom("documents")
      .select("source_id")
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId)
      .executeTakeFirstOrThrow();
    const chunks = await this.db
      .selectFrom("chunks as c")
      .leftJoin("chunk_embeddings as ce", (join) =>
        join
          .onRef("ce.workspace_id", "=", "c.workspace_id")
          .onRef("ce.chunk_id", "=", "c.id")
          .on("ce.embedding_space_id", "=", input.embeddingSpaceId)
          .on("ce.document_revision", "=", input.documentRevision),
      )
      .select(["c.id", "c.chunk_index", "c.content", "c.search_text"])
      .where("c.workspace_id", "=", input.workspaceId)
      .where("c.document_id", "=", input.documentId)
      .where("ce.chunk_id", "is", null)
      .orderBy("c.chunk_index", "asc")
      .execute();

    return {
      outcome: "ready",
      sourceId: document.source_id,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunk_index,
        text: chunk.search_text ?? chunk.content,
      })),
    };
  }

  async commit(
    input: EmbeddingProfileJobCommitInput,
  ): Promise<"completed" | "deleted" | "stale" | "superseded"> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        vectorProjectionMutationFenceKey(input.workspaceId),
      ).execute(trx);
      const fence = await this.readFence(trx, input, true);
      if (fence !== "ready") {
        return mapCommitFence(fence);
      }
      const chunkIds = input.embeddings.map((item) => item.chunkId);
      const currentChunks = chunkIds.length === 0
        ? []
        : await trx
            .selectFrom("chunks")
            .select("id")
            .where("workspace_id", "=", input.workspaceId)
            .where("document_id", "=", input.documentId)
            .where("id", "in", chunkIds)
            .execute();
      if (currentChunks.length !== chunkIds.length) {
        return "stale";
      }

      for (const item of input.embeddings) {
        await upsertCanonicalChunkEmbeddingWithProjection(trx, {
          workspaceId: input.workspaceId,
          chunkId: item.chunkId,
          documentId: input.documentId,
          embeddingSpaceId: input.embeddingSpaceId,
          documentRevision: input.documentRevision,
          canonicalVersion: input.canonicalVersion,
          dimensions: input.space.dimensions,
          embedding: [...item.embedding],
          contentHash: item.contentHash,
        });
      }
      return "completed";
    });
  }

  private async readFence(
    db: Db,
    input: EmbeddingProfileJobLoadInput,
    lock = false,
  ): Promise<"ready" | "document_deleted" | "stale_revision" | "superseded"> {
    let documentQuery = db
      .selectFrom("documents")
      .select(["revision", "status", "retrieval_enabled", "retrieval_expires_at"])
      .where("id", "=", input.documentId)
      .where("workspace_id", "=", input.workspaceId);
    if (lock) {
      documentQuery = documentQuery.forUpdate();
    }
    const document = await documentQuery.executeTakeFirst();
    if (!document) {
      return "document_deleted";
    }
    if (document.revision !== input.documentRevision) {
      return "stale_revision";
    }
    if (
      document.status !== "ready"
      || !document.retrieval_enabled
      || (document.retrieval_expires_at !== null
        && new Date(document.retrieval_expires_at).getTime() <= Date.now())
    ) {
      return "superseded";
    }

    let profileQuery = db
      .selectFrom("workspace_embedding_profiles")
      .select([
        "generation",
        "active_embedding_space_id",
        "pending_embedding_space_id",
      ])
      .where("workspace_id", "=", input.workspaceId);
    if (lock) {
      profileQuery = profileQuery.forUpdate();
    }
    const profile = await profileQuery.executeTakeFirst();
    if (
      !profile
      || String(profile.generation) !== input.expectedWorkspaceProfileGeneration
      || (
        profile.active_embedding_space_id !== input.embeddingSpaceId
        && profile.pending_embedding_space_id !== input.embeddingSpaceId
      )
    ) {
      return "superseded";
    }
    return "ready";
  }
}

const mapCommitFence = (
  outcome: "document_deleted" | "stale_revision" | "superseded",
): "deleted" | "stale" | "superseded" => {
  if (outcome === "document_deleted") {
    return "deleted";
  }
  return outcome === "stale_revision" ? "stale" : "superseded";
};
