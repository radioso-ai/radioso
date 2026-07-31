import { CompiledQuery } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  QualityResolutionReason,
  QualityTriageRecord,
  QualityTriageState,
  SetTriageStateResult,
  ValidatedQualityTriageUpdate,
} from "./contracts/index.js";
import {
  buildEffectiveOpenPredicate,
  buildEffectiveTriageStateExpression,
} from "./turnPopulationSql.js";

type TriageRow = {
  state: string;
  version: number | string;
  resolution_reason: string | null;
  resolution_note: string | null;
  legacy_reason: string | null;
  closed_at: Date | string | null;
  updated_at: Date | string | null;
};

const serializeDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapTriageRow = (row: TriageRow): QualityTriageRecord => ({
  state: row.state as QualityTriageState,
  version: Number(row.version),
  resolution: row.resolution_reason === null
    ? null
    : {
        reason: row.resolution_reason as QualityResolutionReason,
        note: row.resolution_note,
      },
  legacyReason: row.legacy_reason,
  closedAt: row.closed_at === null ? null : serializeDate(row.closed_at),
  updatedAt: row.updated_at === null ? null : serializeDate(row.updated_at),
});

export interface PersistQualityTriageTransitionInput extends ValidatedQualityTriageUpdate {
  assistantMessageId: string;
  updatedBy: string | null;
  linkedEvalCaseId: string | null;
}

/**
 * Quality-owned persistence seam for the mutable triage read model and its
 * immutable transition history.
 */
export class QualityTriageStore {
  constructor(private readonly db: Db) {}

  async transition(
    workspaceId: string,
    input: PersistQualityTriageTransitionInput,
  ): Promise<SetTriageStateResult> {
    // The accepted write and immutable transition are one data-modifying CTE:
    // either both persist or neither does. A separate current-row read after a
    // lost CAS sees the winning concurrent commit under READ COMMITTED.
    const result = await this.db.executeQuery<TriageRow>(
      CompiledQuery.raw(
        `WITH target AS (
           SELECT
             m.workspace_id,
             m.id AS assistant_message_id,
             COALESCE(tr.version, 0) AS current_version,
             ${buildEffectiveTriageStateExpression({
               latestDownUpdatedAtExpression: "feedback.latest_down_updated_at",
             })} AS prior_state
           FROM messages m
           LEFT JOIN assistant_answer_triage tr
             ON tr.workspace_id = m.workspace_id
            AND tr.assistant_message_id = m.id
           LEFT JOIN LATERAL (
             SELECT MAX(f.updated_at) FILTER (WHERE f.value = 'down') AS latest_down_updated_at
             FROM assistant_answer_feedback f
             WHERE f.workspace_id = m.workspace_id
               AND f.assistant_message_id = m.id
           ) feedback ON TRUE
           WHERE m.workspace_id = $1
             AND m.id = $2
             AND m.role = 'assistant'
         ),
         accepted AS (
           INSERT INTO assistant_answer_triage (
             workspace_id,
             assistant_message_id,
             state,
             version,
             resolution_reason,
             resolution_note,
             reason,
             closed_at,
             updated_by,
             updated_at
           )
           SELECT
             target.workspace_id,
             target.assistant_message_id,
             $3,
             1,
             $5,
             $6,
             $7,
             CASE WHEN $3 IN ('resolved', 'dismissed') THEN NOW() ELSE NULL END,
             $8,
             NOW()
           FROM target
           WHERE target.current_version = $4
           ON CONFLICT (workspace_id, assistant_message_id)
           DO UPDATE SET
             state = EXCLUDED.state,
             version = assistant_answer_triage.version + 1,
             resolution_reason = EXCLUDED.resolution_reason,
             resolution_note = EXCLUDED.resolution_note,
             reason = EXCLUDED.reason,
             closed_at = EXCLUDED.closed_at,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
           WHERE assistant_answer_triage.version = $4
           RETURNING
             workspace_id,
             assistant_message_id,
             state,
             version,
             resolution_reason,
             resolution_note,
             reason AS legacy_reason,
             closed_at,
             updated_at
         ),
         transition AS (
           INSERT INTO assistant_answer_triage_transitions (
             workspace_id,
             assistant_message_id,
             prior_state,
             next_state,
             resulting_version,
             actor_id,
             resolution_reason,
             linked_eval_case_id
           )
           SELECT
             accepted.workspace_id,
             accepted.assistant_message_id,
             target.prior_state,
             accepted.state,
             accepted.version,
             $8,
             accepted.resolution_reason,
             $9
           FROM accepted
           JOIN target
             ON target.workspace_id = accepted.workspace_id
            AND target.assistant_message_id = accepted.assistant_message_id
           RETURNING id
         )
         SELECT
           state,
           version,
           resolution_reason,
           resolution_note,
           legacy_reason,
           closed_at,
           updated_at
         FROM accepted`,
        [
          workspaceId,
          input.assistantMessageId,
          input.state,
          input.expectedVersion,
          input.resolution?.reason ?? null,
          input.resolution?.note ?? null,
          input.legacyReason,
          input.updatedBy,
          input.linkedEvalCaseId,
        ],
      ),
    );

    const row = result.rows[0];
    if (row) {
      return { kind: "updated", record: mapTriageRow(row) };
    }

    const current = await this.readCurrent(workspaceId, input.assistantMessageId);
    return current === null
      ? { kind: "not_found" }
      : { kind: "conflict", current };
  }

  private async readCurrent(
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<QualityTriageRecord | null> {
    const result = await this.db.executeQuery<TriageRow>(
      CompiledQuery.raw(
        `SELECT
           CASE WHEN current.effective_open THEN 'open' ELSE current.persisted_state END AS state,
           current.version,
           CASE WHEN current.effective_open THEN NULL ELSE current.resolution_reason END
             AS resolution_reason,
           CASE WHEN current.effective_open THEN NULL ELSE current.resolution_note END
             AS resolution_note,
           CASE WHEN current.effective_open THEN NULL ELSE current.legacy_reason END
             AS legacy_reason,
           CASE WHEN current.effective_open THEN NULL ELSE current.closed_at END AS closed_at,
           CASE WHEN current.effective_open THEN NULL ELSE current.updated_at END AS updated_at
         FROM (
           SELECT
             COALESCE(tr.state, 'open') AS persisted_state,
             COALESCE(tr.version, 0) AS version,
             tr.resolution_reason,
             tr.resolution_note,
             tr.reason AS legacy_reason,
             tr.closed_at,
             tr.updated_at,
             (${buildEffectiveOpenPredicate()}) AS effective_open
           FROM messages m
           LEFT JOIN assistant_answer_triage tr
             ON tr.workspace_id = m.workspace_id
            AND tr.assistant_message_id = m.id
           WHERE m.workspace_id = $1
             AND m.id = $2
             AND m.role = 'assistant'
         ) current`,
        [workspaceId, assistantMessageId],
      ),
    );
    return result.rows[0] ? mapTriageRow(result.rows[0]) : null;
  }
}
