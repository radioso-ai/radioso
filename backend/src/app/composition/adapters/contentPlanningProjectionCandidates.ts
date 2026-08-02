import { sql } from "kysely";

import type { ContentPlanningProjectionCandidateSourcePort } from "../../../modules/contentPlanning/services/contentPlanningWorkerRuntime.js";
import { utcBudgetWindowStart } from "../../../modules/contentPlanning/services/projectionBudgetService.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

export class PostgresContentPlanProjectionCandidateSource
implements ContentPlanningProjectionCandidateSourcePort {
  constructor(private readonly db: Db) {}

  async listCandidates(input: {
    afterWorkspaceId?: string;
    limit: number;
    now: Date;
  }) {
    validateInput(input);
    const budgetWindowStartedAt = utcBudgetWindowStart(input.now);
    let query = this.db
      .selectFrom("workspaces as workspace")
      .innerJoin(
        "workspace_embedding_profiles as profile",
        "profile.workspace_id",
        "workspace.id",
      )
      .leftJoin(
        "content_plan_projection_states as projection_state",
        "projection_state.workspace_id",
        "workspace.id",
      )
      .select([
        "workspace.id as workspace_id",
        "profile.active_embedding_space_id as embedding_space_id",
      ])
      .where(sql<boolean>`
        projection_state.workspace_id IS NULL
        OR (
          projection_state.projection_state = 'budget_paused'
          AND projection_state.budget_window_started_at < ${budgetWindowStartedAt}
        )
        OR (
          projection_state.projection_state <> 'budget_paused'
          AND (
            projection_state.projection_state <> 'ready'
            OR NOT EXISTS (
              SELECT 1
              FROM content_plan_projection_generations AS coherent_generation
              WHERE coherent_generation.workspace_id = workspace.id
                AND coherent_generation.id = projection_state.coherent_generation_id
                AND coherent_generation.state = 'coherent'
                AND coherent_generation.embedding_space_id = profile.active_embedding_space_id
            )
            OR EXISTS (
              SELECT 1
              FROM content_plan_observation_vectors AS embedding_work
              INNER JOIN content_plan_projection_generations AS embedding_generation
                ON embedding_generation.workspace_id = embedding_work.workspace_id
               AND embedding_generation.id = embedding_work.generation_id
               AND embedding_generation.state IN ('building', 'coherent')
              WHERE embedding_work.workspace_id = workspace.id
                AND embedding_work.embedding IS NULL
                AND (
                  (
                    embedding_work.state IN ('pending_embedding', 'retryable')
                    AND embedding_work.available_at <= ${input.now}
                  )
                  OR (
                    embedding_work.state = 'processing'
                    AND embedding_work.claim_expires_at <= ${input.now}
                  )
                )
            )
          )
        )
        OR EXISTS (
          SELECT 1
          FROM content_plan_observation_vectors AS assignment_work
          INNER JOIN content_plan_projection_generations AS assignment_generation
            ON assignment_generation.workspace_id = assignment_work.workspace_id
           AND assignment_generation.id = assignment_work.generation_id
           AND assignment_generation.state IN ('building', 'coherent')
          WHERE assignment_work.workspace_id = workspace.id
            AND assignment_work.embedding IS NOT NULL
            AND (
              (
                assignment_work.state IN ('ready', 'retryable')
                AND assignment_work.available_at <= ${input.now}
              )
              OR (
                assignment_work.state = 'processing'
                AND assignment_work.claim_expires_at <= ${input.now}
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM content_plan_topics AS dirty_topic
          INNER JOIN content_plan_projection_generations AS topic_generation
            ON topic_generation.workspace_id = dirty_topic.workspace_id
           AND topic_generation.id = dirty_topic.generation_id
           AND topic_generation.state IN ('building', 'coherent')
          WHERE dirty_topic.workspace_id = workspace.id
            AND dirty_topic.lifecycle = 'mature'
            AND dirty_topic.enrichment_dirty_at IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM content_plan_topic_enrichments AS enrichment_work
          INNER JOIN content_plan_projection_generations AS enrichment_generation
            ON enrichment_generation.workspace_id = enrichment_work.workspace_id
           AND enrichment_generation.id = enrichment_work.generation_id
           AND enrichment_generation.state IN ('building', 'coherent')
          WHERE enrichment_work.workspace_id = workspace.id
            AND enrichment_work.state IN ('pending', 'stale')
            AND enrichment_work.available_at <= ${input.now}
            AND (
              enrichment_work.claim_token IS NULL
              OR enrichment_work.claim_expires_at <= ${input.now}
            )
        )
      `);
    if (input.afterWorkspaceId) {
      query = query.where("workspace.id", ">", input.afterWorkspaceId);
    }
    const rows = await query
      .orderBy("workspace.id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      embeddingSpaceId: row.embedding_space_id,
    }));
  }

  async listMaintenanceCandidates(input: {
    afterWorkspaceId?: string;
    limit: number;
  }) {
    validateInput(input);
    let query = this.db
      .selectFrom("workspaces as workspace")
      .innerJoin(
        "workspace_embedding_profiles as profile",
        "profile.workspace_id",
        "workspace.id",
      )
      .select([
        "workspace.id as workspace_id",
        "profile.active_embedding_space_id as embedding_space_id",
      ]);
    if (input.afterWorkspaceId) {
      query = query.where("workspace.id", ">", input.afterWorkspaceId);
    }
    const rows = await query
      .orderBy("workspace.id", "asc")
      .limit(input.limit)
      .execute();
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      embeddingSpaceId: row.embedding_space_id,
    }));
  }
}

const validateInput = (input: { limit: number; now?: Date }): void => {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Content planning projection candidate limit must be between 1 and 100");
  }
  if (input.now && !Number.isFinite(input.now.getTime())) {
    throw new Error("Content planning projection candidate time must be valid");
  }
};
