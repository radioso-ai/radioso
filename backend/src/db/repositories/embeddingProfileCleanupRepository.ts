import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  EmbeddingProfileCleanupCandidate,
  EmbeddingProfileCleanupRepositoryPort,
} from "../../modules/embeddingProfiles/services/embeddingProfileCleanupService.js";

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
  }): Promise<"cleaned" | "refused" | "already_cleaned"> {
    return this.db.transaction().execute(async (trx) => {
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
        vectorWorkReference,
        vectorCheckpointReference,
      ] =
        await Promise.all([
          trx
            .selectFrom("workspace_embedding_profiles")
            .select("workspace_id")
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
            .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
            .where("status", "in", ["queued", "processing", "failed"])
            .executeTakeFirst(),
          trx
            .selectFrom("vector_index_work")
            .select("id")
            .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
            .executeTakeFirst(),
          trx
            .selectFrom("vector_index_checkpoints")
            .select("backend_key")
            .where("embedding_space_id", "=", input.candidate.embeddingSpaceId)
            .executeTakeFirst(),
        ]);
      // Completed projection rows and checkpoints are still backend references.
      // A future fenced reset seam must remove them before canonical cleanup may
      // complete; silently orphaning projected vectors is never acceptable.
      if (
        profileReference
        || liveTransition
        || liveJob
        || vectorWorkReference
        || vectorCheckpointReference
      ) {
        return "refused";
      }

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
        .where("id", "=", input.candidate.transitionId)
        .execute();
      return "cleaned";
    });
  }
}
