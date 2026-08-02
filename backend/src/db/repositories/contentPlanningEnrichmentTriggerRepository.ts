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
}
