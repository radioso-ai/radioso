import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  EmbeddingProfileCleanupCandidate,
  EmbeddingProfileCleanupRepositoryPort,
} from "../../modules/embeddingProfiles/services/embeddingProfileCleanupService.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";
import { vectorProjectionMutationFenceKey } from "./vectorIndexWorkRepository.js";

export class EmbeddingProfileCleanupRepository
implements EmbeddingProfileCleanupRepositoryPort {
  constructor(private readonly db: Db) {}

  async listDue(input: {
    now: Date;
    limit: number;
  }): Promise<EmbeddingProfileCleanupCandidate[]> {
    const rows = await this.db
      .selectFrom("workspace_embedding_transitions")
      .select([
        "id",
        "workspace_id",
        "source_embedding_space_id",
        "generation",
      ])
      .where("status", "=", "promoted")
      .where("cleanup_after", "is not", null)
      .where("cleanup_after", "<=", input.now)
      .orderBy("cleanup_after", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      transitionId: row.id,
      workspaceId: row.workspace_id,
      embeddingSpaceId: row.source_embedding_space_id,
      generation: String(row.generation),
    }));
  }

  async cleanupIfSafe(input: {
    candidate: EmbeddingProfileCleanupCandidate;
    now: Date;
    cleanupProjection(): Promise<void>;
  }): Promise<"cleaned" | "refused" | "already_cleaned"> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        vectorProjectionMutationFenceKey(input.candidate.workspaceId),
      ).execute(trx);
      const transition = await trx
        .selectFrom("workspace_embedding_transitions")
        .select([
          "status",
          "cleanup_after",
          "source_embedding_space_id",
          "generation",
        ])
        .where("id", "=", input.candidate.transitionId)
        .where("workspace_id", "=", input.candidate.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!transition || transition.cleanup_after === null) {
        return "already_cleaned";
      }
      if (
        transition.status !== "promoted"
        || transition.source_embedding_space_id !== input.candidate.embeddingSpaceId
        || String(transition.generation) !== input.candidate.generation
        || new Date(transition.cleanup_after).getTime() > input.now.getTime()
      ) {
        return "refused";
      }

      // Serialize cleanup with publication, cancellation, and promotion. The
      // live-reference predicates below are evaluated while this profile fence
      // remains locked.
      await trx
        .selectFrom("workspace_embedding_profiles")
        .select("workspace_id")
        .where("workspace_id", "=", input.candidate.workspaceId)
        .forUpdate()
        .executeTakeFirst();

      const [
        profileReference,
        liveTransition,
        liveJob,
        futureRetention,
      ] =
        await Promise.all([
          trx
            .selectFrom("workspace_embedding_profiles")
            .select("workspace_id")
            .where("workspace_id", "=", input.candidate.workspaceId)
            .where((eb) =>
              eb.or([
                eb("active_embedding_space_id", "=", input.candidate.embeddingSpaceId),
                eb("pending_embedding_space_id", "=", input.candidate.embeddingSpaceId),
              ]),
            )
            .executeTakeFirst(),
          trx
            .selectFrom("workspace_embedding_transitions")
            .select("id")
            .where("workspace_id", "=", input.candidate.workspaceId)
            .where("id", "!=", input.candidate.transitionId)
            .where((eb) =>
              eb.or([
                eb("source_embedding_space_id", "=", input.candidate.embeddingSpaceId),
                eb("target_embedding_space_id", "=", input.candidate.embeddingSpaceId),
              ]),
            )
            .where("status", "in", ["building", "blocked", "quarantined"])
            .executeTakeFirst(),
          trx
            .selectFrom("document_processing_jobs")
            .select("id")
            .where("workspace_id", "=", input.candidate.workspaceId)
            .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
            .where("status", "in", ["queued", "processing", "failed"])
            .executeTakeFirst(),
          trx
            .selectFrom("workspace_embedding_transitions")
            .select("id")
            .where("workspace_id", "=", input.candidate.workspaceId)
            .where(
              "source_embedding_space_id",
              "=",
              input.candidate.embeddingSpaceId,
            )
            .where("status", "=", "promoted")
            .where("cleanup_after", ">", input.now)
            .executeTakeFirst(),
        ]);
      const mutableVectorWork = await trx
        .selectFrom("vector_index_work")
        .select(["id", "status"])
        .where("workspace_id", "=", input.candidate.workspaceId)
        .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
        .where("status", "in", ["queued", "processing", "failed"])
        .forUpdate()
        .execute();
      const inFlightVectorWork = mutableVectorWork.some(
        (work) => work.status === "processing",
      );
      if (
        profileReference
        || liveTransition
        || liveJob
        || futureRetention
        || inFlightVectorWork
      ) {
        return "refused";
      }

      // Retire the adapter projection while the workspace profile fence remains
      // locked. If the idempotent reset fails, this transaction rolls back and
      // leaves the canonical vectors and durable synchronization state retryable.
      await input.cleanupProjection();
      await trx
        .deleteFrom("vector_index_checkpoints")
        .where("workspace_id", "=", input.candidate.workspaceId)
        .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
        .execute();
      await trx
        .deleteFrom("vector_index_work")
        .where("workspace_id", "=", input.candidate.workspaceId)
        .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
        .execute();
      await trx
        .deleteFrom("chunk_embeddings")
        .where("workspace_id", "=", input.candidate.workspaceId)
        .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
        .execute();
      await trx
        .updateTable("workspace_embedding_transitions")
        .set({
          cleanup_after: null,
          updated_at: input.now,
        })
        .where("workspace_id", "=", input.candidate.workspaceId)
        .where(
          "source_embedding_space_id",
          "=",
          input.candidate.embeddingSpaceId,
        )
        .where("status", "=", "promoted")
        .where("cleanup_after", "is not", null)
        .execute();
      return "cleaned";
    });
  }
}
