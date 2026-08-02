import { CompiledQuery } from "kysely";

import type { Db } from "../../../shared/infra/kysely/types.js";
import { CONTENT_PLAN_PROJECTION_STATES } from "../contracts/index.js";
import type {
  ContentPlanningOperationalMetricsSnapshot,
  ContentPlanningOperationalMetricsSourcePort,
} from "../services/operationalMetricsReporter.js";

type Scalar = number | string;

interface OperationalMetricsRow {
  projection_kind: ContentPlanningOperationalMetricsSnapshot["projectionKind"];
  projection_state: ContentPlanningOperationalMetricsSnapshot["projectionState"];
  processed_through: Date | string | null;
  bootstrap_processed: Scalar | null;
  bootstrap_total: Scalar | null;
  pending_observation_count: Scalar;
  pending_embedding_count: Scalar;
  pending_assignment_count: Scalar;
  pending_enrichment_count: Scalar;
  provisional_topic_count: Scalar;
  mature_topic_count: Scalar;
  merged_topic_count: Scalar;
}

/** One scalar-only query used by the worker's bounded operational metrics reporter. */
export class PostgresContentPlanningOperationalMetricsSource
implements ContentPlanningOperationalMetricsSourcePort {
  constructor(private readonly db: Db) {}

  async load(input: {
    workspaceId: string;
    generationId: string;
  }): Promise<ContentPlanningOperationalMetricsSnapshot> {
    const result = await this.db.executeQuery<OperationalMetricsRow>(CompiledQuery.raw(
      `SELECT
         generation.kind AS projection_kind,
         state.projection_state,
         state.processed_through,
         state.bootstrap_processed,
         state.bootstrap_total,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_observations observation
           LEFT JOIN content_plan_observation_vectors vector
             ON vector.workspace_id = observation.workspace_id
            AND vector.observation_id = observation.id
            AND vector.generation_id = $2
           WHERE observation.workspace_id = $1
             AND observation.observation_state IN ('pending_context', 'ready')
             AND (
               observation.observation_state = 'pending_context'
               OR vector.observation_id IS NULL
               OR vector.state IN ('pending_embedding', 'ready', 'processing', 'retryable')
             )
         ), 0) AS pending_observation_count,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_observation_vectors vector
           WHERE vector.workspace_id = $1
             AND vector.generation_id = $2
             AND vector.embedding IS NULL
             AND vector.state IN ('pending_embedding', 'processing', 'retryable')
         ), 0) AS pending_embedding_count,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_observation_vectors vector
           WHERE vector.workspace_id = $1
             AND vector.generation_id = $2
             AND vector.embedding IS NOT NULL
             AND vector.state IN ('ready', 'processing', 'retryable')
         ), 0) AS pending_assignment_count,
         COALESCE((
           SELECT COUNT(*)
           FROM content_plan_topics topic
           LEFT JOIN content_plan_topic_enrichments enrichment
             ON enrichment.workspace_id = topic.workspace_id
            AND enrichment.generation_id = topic.generation_id
            AND enrichment.topic_id = topic.id
           WHERE topic.workspace_id = $1
             AND topic.generation_id = $2
             AND topic.lifecycle = 'mature'
             AND (
               (
                 enrichment.topic_id IS NULL
                 AND topic.enrichment_dirty_at IS NOT NULL
               )
               OR enrichment.state IN ('pending', 'stale')
               OR enrichment.source_topic_revision <> topic.revision
             )
         ), 0) AS pending_enrichment_count,
         COALESCE((
           SELECT COUNT(*) FROM content_plan_topics topic
           WHERE topic.workspace_id = $1
             AND topic.generation_id = $2
             AND topic.lifecycle = 'provisional'
         ), 0) AS provisional_topic_count,
         COALESCE((
           SELECT COUNT(*) FROM content_plan_topics topic
           WHERE topic.workspace_id = $1
             AND topic.generation_id = $2
             AND topic.lifecycle = 'mature'
         ), 0) AS mature_topic_count,
         COALESCE((
           SELECT COUNT(*) FROM content_plan_topics topic
           WHERE topic.workspace_id = $1
             AND topic.generation_id = $2
             AND topic.lifecycle = 'merged'
         ), 0) AS merged_topic_count
       FROM content_plan_projection_states state
       JOIN content_plan_projection_generations generation
         ON generation.workspace_id = state.workspace_id
        AND generation.id = $2
       WHERE state.workspace_id = $1`,
      [input.workspaceId, input.generationId],
    ));
    const row = result.rows[0];
    if (
      !row
      || !CONTENT_PLAN_PROJECTION_STATES.includes(row.projection_state)
      || (row.projection_kind !== "bootstrap" && row.projection_kind !== "reprojection")
    ) {
      throw new Error("Content planning operational metrics snapshot is unavailable");
    }
    return {
      projectionState: row.projection_state,
      projectionKind: row.projection_kind,
      processedThrough: nullableDate(row.processed_through),
      processedCount: nullableCount(row.bootstrap_processed),
      totalCount: nullableCount(row.bootstrap_total),
      pendingObservationCount: count(row.pending_observation_count),
      pendingEmbeddingCount: count(row.pending_embedding_count),
      pendingAssignmentCount: count(row.pending_assignment_count),
      pendingEnrichmentCount: count(row.pending_enrichment_count),
      provisionalTopicCount: count(row.provisional_topic_count),
      matureTopicCount: count(row.mature_topic_count),
      mergedTopicCount: count(row.merged_topic_count),
    };
  }
}

const count = (value: Scalar): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Content planning operational count exceeds safe bounds");
  }
  return parsed;
};

const nullableCount = (value: Scalar | null): number | null => value === null ? null : count(value);

const nullableDate = (value: Date | string | null): Date | null => {
  if (value === null) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Content planning operational timestamp is invalid");
  }
  return parsed;
};
