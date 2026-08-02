import { sql } from "kysely";

import type {
  ContentPlanCorpusInvalidationDrainResult,
  ContentPlanCorpusInvalidationRepositoryPort,
} from "../../modules/contentPlanning/services/corpusInvalidation.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const MAX_CORPUS_INVALIDATION_BATCH_SIZE = 100;

type MarkerRow = {
  revision: string;
  dirty_at: Date;
  after_generation_id: string | null;
  after_topic_id: string | null;
};

type TopicRow = {
  generation_id: string;
  id: string;
  revision: number;
};

export class ContentPlanCorpusInvalidationRepository
implements ContentPlanCorpusInvalidationRepositoryPort {
  constructor(private readonly db: Db) {}

  async markWorkspaceDirty(input: { workspaceId: string; dirtyAt: Date }): Promise<void> {
    assertValidTime(input.dirtyAt);
    await this.db
      .insertInto("content_plan_corpus_invalidations")
      .values({
        workspace_id: input.workspaceId,
        revision: "1",
        dirty_at: input.dirtyAt,
        after_generation_id: null,
        after_topic_id: null,
      })
      .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet({
        revision: sql`content_plan_corpus_invalidations.revision + 1`,
        dirty_at: sql`GREATEST(content_plan_corpus_invalidations.dirty_at, excluded.dirty_at)`,
        after_generation_id: null,
        after_topic_id: null,
        updated_at: currentTimestamp(),
      }))
      .execute();
  }

  async invalidateDeletedDocument(input: {
    workspaceId: string;
    documentId: string;
    dirtyAt: Date;
  }): Promise<number> {
    assertValidTime(input.dirtyAt);
    return this.db.transaction().execute(async (trx) => {
      const linked = await trx
        .selectFrom("content_plan_topic_documents")
        .select(["generation_id", "topic_id"])
        .distinct()
        .where("workspace_id", "=", input.workspaceId)
        .where("document_id", "=", input.documentId)
        .orderBy("generation_id", "asc")
        .orderBy("topic_id", "asc")
        .execute();
      let invalidated = 0;
      for (const topic of linked) {
        const updated = await trx
          .updateTable("content_plan_topics")
          .set((eb) => ({
            revision: eb("revision", "+", 1),
            enrichment_dirty_at: input.dirtyAt,
            updated_at: currentTimestamp(),
          }))
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", topic.generation_id)
          .where("id", "=", topic.topic_id)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) continue;
        invalidated += 1;
        await staleEnrichment(trx, input.workspaceId, topic.generation_id, topic.topic_id);
        await trx
          .deleteFrom("content_plan_topic_documents")
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", topic.generation_id)
          .where("topic_id", "=", topic.topic_id)
          .execute();
      }
      return invalidated;
    });
  }

  async drainWorkspace(input: {
    workspaceId: string;
    limit: number;
  }): Promise<ContentPlanCorpusInvalidationDrainResult> {
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > MAX_CORPUS_INVALIDATION_BATCH_SIZE
    ) {
      throw new RangeError(
        `Content planning corpus invalidation batch must be between 1 and ${MAX_CORPUS_INVALIDATION_BATCH_SIZE}`,
      );
    }
    return this.db.transaction().execute(async (trx) => {
      const marker = await trx
        .selectFrom("content_plan_corpus_invalidations")
        .select(["revision", "dirty_at", "after_generation_id", "after_topic_id"])
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst() as MarkerRow | undefined;
      if (!marker) return emptyDrain();

      let candidates = trx
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
        ]));
      if (marker.after_generation_id && marker.after_topic_id) {
        candidates = candidates.where((eb) => eb.or([
          eb("topic.generation_id", ">", marker.after_generation_id!),
          eb.and([
            eb("topic.generation_id", "=", marker.after_generation_id!),
            eb("topic.id", ">", marker.after_topic_id!),
          ]),
        ]));
      }
      const rows = await candidates
        .orderBy("topic.generation_id", "asc")
        .orderBy("topic.id", "asc")
        .forUpdate("topic")
        .limit(input.limit + 1)
        .execute() as TopicRow[];
      const selected = rows.slice(0, input.limit);
      let invalidatedCount = 0;
      for (const topic of selected) {
        const updated = await trx
          .updateTable("content_plan_topics")
          .set((eb) => ({
            revision: eb("revision", "+", 1),
            enrichment_dirty_at: marker.dirty_at,
            updated_at: currentTimestamp(),
          }))
          .where("workspace_id", "=", input.workspaceId)
          .where("generation_id", "=", topic.generation_id)
          .where("id", "=", topic.id)
          .where("revision", "=", topic.revision)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) continue;
        invalidatedCount += 1;
        await staleEnrichment(trx, input.workspaceId, topic.generation_id, topic.id);
      }

      const pending = rows.length > input.limit;
      if (pending) {
        const last = selected.at(-1)!;
        await trx
          .updateTable("content_plan_corpus_invalidations")
          .set({
            after_generation_id: last.generation_id,
            after_topic_id: last.id,
            updated_at: currentTimestamp(),
          })
          .where("workspace_id", "=", input.workspaceId)
          .where("revision", "=", marker.revision)
          .executeTakeFirst();
      } else {
        await trx
          .deleteFrom("content_plan_corpus_invalidations")
          .where("workspace_id", "=", input.workspaceId)
          .where("revision", "=", marker.revision)
          .executeTakeFirst();
      }
      return {
        invalidatedCount,
        pending,
        markerRevision: marker.revision,
      };
    });
  }
}

const staleEnrichment = async (
  db: Db,
  workspaceId: string,
  generationId: string,
  topicId: string,
): Promise<void> => {
  await db
    .updateTable("content_plan_topic_enrichments")
    .set((eb) => ({
      state: eb.case()
        .when("state", "in", ["ready", "outside_analysis_cap"])
        .then("stale")
        .else(eb.ref("state"))
        .end(),
      corpus_state: "stale",
      claim_token: null,
      claim_expires_at: null,
      updated_at: currentTimestamp(),
    }))
    .where("workspace_id", "=", workspaceId)
    .where("generation_id", "=", generationId)
    .where("topic_id", "=", topicId)
    .executeTakeFirst();
};

const emptyDrain = (): ContentPlanCorpusInvalidationDrainResult => ({
  invalidatedCount: 0,
  pending: false,
  markerRevision: null,
});

const assertValidTime = (value: Date): void => {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError("Content planning corpus invalidation time is invalid");
  }
};
