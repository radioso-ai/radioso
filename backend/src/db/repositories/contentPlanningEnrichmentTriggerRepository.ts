import type {
  ContentPlanEnrichmentDirtyMarker,
  ContentPlanEnrichmentTriggerPort,
} from "../../modules/contentPlanning/services/enrichmentPlanningService.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const MAX_DIRTY_TOPIC_BATCH_SIZE = 500;

/**
 * Durable, low-cost trigger state for enrichment planning. This repository is
 * intentionally separate from provider-job persistence: polling dirty topics
 * must not require loading the rolling report or Quality evidence.
 */
export class ContentPlanEnrichmentTriggerRepository
implements ContentPlanEnrichmentTriggerPort {
  constructor(private readonly db: Db) {}

  async listDirtyTopics(input: {
    workspaceId: string;
    generationId: string;
    limit: number;
  }): Promise<ContentPlanEnrichmentDirtyMarker[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_DIRTY_TOPIC_BATCH_SIZE) {
      throw new Error(`Content planning dirty topic limit must be between 1 and ${MAX_DIRTY_TOPIC_BATCH_SIZE}`);
    }
    const rows = await this.db
      .selectFrom("content_plan_topics")
      .select(["id", "revision", "enrichment_dirty_at"])
      .where("workspace_id", "=", input.workspaceId)
      .where("generation_id", "=", input.generationId)
      .where("lifecycle", "=", "mature")
      .where("enrichment_dirty_at", "is not", null)
      .orderBy("enrichment_dirty_at", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      topicId: row.id,
      revision: row.revision,
      dirtyAt: new Date(row.enrichment_dirty_at!),
    }));
  }

  async acknowledgeDirtyTopics(input: {
    workspaceId: string;
    generationId: string;
    markers: readonly ContentPlanEnrichmentDirtyMarker[];
  }): Promise<number> {
    if (input.markers.length === 0) return 0;
    if (input.markers.length > MAX_DIRTY_TOPIC_BATCH_SIZE) {
      throw new Error(`Content planning dirty marker batch exceeds ${MAX_DIRTY_TOPIC_BATCH_SIZE}`);
    }
    return this.db.transaction().execute(async (trx) => {
      let acknowledged = 0;
      for (const marker of input.markers) {
        const result = await trx
          .updateTable("content_plan_topics")
          .set({
            enrichment_dirty_at: null,
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", input.generationId)
          .where("id", "=", marker.topicId)
          .where("revision", "=", marker.revision)
          .where("enrichment_dirty_at", "=", marker.dirtyAt)
          .executeTakeFirst();
        acknowledged += Number(result.numUpdatedRows);
      }
      return acknowledged;
    });
  }

  async invalidateWorkspaceCorpusEvidence(input: {
    workspaceId: string;
    dirtyAt: Date;
  }): Promise<number> {
    if (!Number.isFinite(input.dirtyAt.getTime())) {
      throw new Error("Content planning corpus invalidation time is invalid");
    }
    return this.db.transaction().execute(async (trx) => {
      const affected = await trx
        .selectFrom("content_plan_topics as topic")
        .innerJoin("content_plan_topic_enrichments as enrichment", (join) => join
          .onRef("enrichment.workspace_id", "=", "topic.workspace_id")
          .onRef("enrichment.generation_id", "=", "topic.generation_id")
          .onRef("enrichment.topic_id", "=", "topic.id"))
        .select(["topic.generation_id", "topic.id", "topic.revision"])
        .where("topic.workspace_id", "=", input.workspaceId)
        .where("topic.lifecycle", "=", "mature")
        .where((eb) => eb.or([
          eb("enrichment.source_credible_opportunity", "=", true),
          eb("enrichment.published_source_credible_opportunity", "=", true),
        ]))
        .orderBy("topic.generation_id", "asc")
        .orderBy("topic.id", "asc")
        .forUpdate()
        .execute();

      let invalidated = 0;
      for (const topic of affected) {
        const updated = await trx
          .updateTable("content_plan_topics")
          .set((eb) => ({
            revision: eb("revision", "+", 1),
            enrichment_dirty_at: input.dirtyAt,
            updated_at: currentTimestamp(),
          }))
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", topic.generation_id)
          .where("id", "=", topic.id)
          .where("revision", "=", topic.revision)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) === 0) continue;
        invalidated += 1;
        await trx
          .updateTable("content_plan_topic_enrichments")
          .set((eb) => ({
            state: eb.case().when("state", "=", "ready").then("stale").else(eb.ref("state")).end(),
            corpus_state: "stale",
            claim_token: null,
            claim_expires_at: null,
            updated_at: currentTimestamp(),
          }))
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", topic.generation_id)
          .where("topic_id", "=", topic.id)
          .executeTakeFirst();
      }
      return invalidated;
    });
  }
}
