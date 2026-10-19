import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

import {
  exportJson,
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../shared/domain/dataSubjectAccess.js";
import { anyOf, currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface RoutineStateRow {
  // SQL rows keep database column names; the repository maps to the contract record.
  session_id: string;
  routine_id: string;
  execution_id: string | null;
  started_message_id: string | null;
  started_execution_id: string | null;
  path: string[] | null;
  variables: Record<string, unknown> | null;
  attempts: Record<string, unknown> | null;
  reask_count: number;
  status: string;
  expires_at: Date | null;
}

const routineStateColumns = [
  "session_id",
  "routine_id",
  "execution_id",
  "started_message_id",
  "started_execution_id",
  "path",
  "variables",
  "attempts",
  "reask_count",
  "status",
  "expires_at",
] as const;

const mapAttempts = (value: Record<string, unknown> | null): Record<string, number> | undefined => {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const mapState = (row: RoutineStateRow): RoutineState => {
  const attempts = mapAttempts(row.attempts);
  return {
    sessionId: row.session_id,
    routineId: row.routine_id,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.started_message_id && row.started_execution_id === row.execution_id
      ? { startedMessageId: row.started_message_id }
      : {}),
    path: row.path ?? [],
    variables: row.variables ?? {},
    ...(attempts ? { attempts } : {}),
    ...(row.reask_count > 0 ? { reaskCount: row.reask_count } : {}),
    status: (row.status as RoutineState["status"]) ?? "active",
  };
};

export const DEFAULT_ROUTINE_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * Generic DB-backed {@link ConversationRoutineStore}: at most one in-flight routine
 * per session, resumed from its `path` + `variables` and cleared on completion. It
 * owns expiry (TTL) — `loadActive` never returns an expired flow — so the engine
 * never resumes an abandoned routine. Not specific to any routine; any registered
 * routine persists here.
 */
export class RoutineStateRepository implements ConversationRoutineStore {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = DEFAULT_ROUTINE_STATE_TTL_MS,
  ) {}

  async loadActive(input: { sessionId: string }): Promise<RoutineState | null> {
    const row = await this.db
      .selectFrom("routine_states")
      .select(routineStateColumns)
      .where("session_id", "=", input.sessionId)
      .where("status", "=", "active")
      // expires_at IS NULL OR expires_at > now()
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", currentTimestamp())]))
      .executeTakeFirst();
    return row ? mapState(row as RoutineStateRow) : null;
  }

  async loadCompleted(input: { sessionId: string }): Promise<RoutineState[]> {
    const rows = await this.db
      .selectFrom("routine_states")
      .select(routineStateColumns)
      .where("session_id", "=", input.sessionId)
      .where("status", "=", "completed")
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", currentTimestamp())]))
      .execute();
    return rows.map((row) => mapState(row as RoutineStateRow));
  }

  async loadSuspended(input: { sessionId: string }): Promise<RoutineState | null> {
    const row = await this.db
      .selectFrom("routine_states")
      .select(routineStateColumns)
      .where("session_id", "=", input.sessionId)
      .where("status", "=", "suspended")
      .executeTakeFirst();
    return row ? mapState(row as RoutineStateRow) : null;
  }

  async save(state: RoutineState): Promise<void> {
    const expiresAt = state.status === "suspended" ? null : new Date(Date.now() + this.ttlMs);
    // One row per session — advancing a routine upserts; an expired row is overwritten
    // when a fresh routine activates for the same session.
    await this.db
      .insertInto("routine_states")
      .values({
        session_id: state.sessionId,
        routine_id: state.routineId,
        execution_id: state.executionId ?? null,
        started_message_id: state.startedMessageId ?? null,
        started_execution_id: state.startedMessageId ? state.executionId ?? null : null,
        path: state.path,
        variables: toJsonb(state.variables),
        attempts: toJsonb(state.attempts ?? {}),
        reask_count: state.reaskCount ?? 0,
        status: state.status,
        expires_at: expiresAt,
        updated_at: currentTimestamp(),
      })
      .onConflict((oc) =>
        oc.column("session_id").doUpdateSet((eb) => ({
          routine_id: eb.ref("excluded.routine_id"),
          execution_id: eb.ref("excluded.execution_id"),
          started_message_id: eb.ref("excluded.started_message_id"),
          started_execution_id: eb.ref("excluded.started_execution_id"),
          path: eb.ref("excluded.path"),
          variables: eb.ref("excluded.variables"),
          attempts: eb.ref("excluded.attempts"),
          reask_count: eb.ref("excluded.reask_count"),
          status: eb.ref("excluded.status"),
          expires_at: eb.ref("excluded.expires_at"),
          updated_at: currentTimestamp(),
        })),
      )
      .execute();
  }

  async clear(input: { sessionId: string }): Promise<void> {
    await this.db.deleteFrom("routine_states").where("session_id", "=", input.sessionId).execute();
  }
}

/**
 * The export's `routine_values` section: what the routine a conversation last ran collected, kept
 * on its routine state until another routine replaces it, expired or not.
 */
export class RoutineValueExporter implements DataSubjectDataExporter {
  readonly section = "routine_values";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("routine_states as r")
      .innerJoin("conversations as c", "c.id", "r.session_id")
      .select(["r.session_id", "r.routine_id", "r.status", "r.variables", "r.created_at", "r.updated_at"])
      .where("c.workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("r.session_id"), scope.conversationIds, "uuid[]"))
      .orderBy("r.created_at")
      .orderBy("r.session_id")
      .execute();
    return rows.map((row) => ({
      conversationId: row.session_id,
      routineId: row.routine_id,
      status: row.status,
      values: exportJson(row.variables),
      startedAt: exportTimestamp(row.created_at),
      updatedAt: exportTimestamp(row.updated_at),
    }));
  }
}
