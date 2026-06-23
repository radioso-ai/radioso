import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface RoutineStateRow {
  // SQL rows keep database column names; the repository maps to the contract record.
  session_id: string;
  routine_id: string;
  path: string[] | null;
  variables: Record<string, unknown> | null;
  attempts: Record<string, unknown> | null;
  status: string;
  expires_at: Date | null;
}

const routineStateColumns = ["session_id", "routine_id", "path", "variables", "attempts", "status", "expires_at"] as const;

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
    path: row.path ?? [],
    variables: row.variables ?? {},
    ...(attempts ? { attempts } : {}),
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
        path: state.path,
        variables: toJsonb(state.variables),
        attempts: toJsonb(state.attempts ?? {}),
        status: state.status,
        expires_at: expiresAt,
        updated_at: currentTimestamp(),
      })
      .onConflict((oc) =>
        oc.column("session_id").doUpdateSet((eb) => ({
          routine_id: eb.ref("excluded.routine_id"),
          path: eb.ref("excluded.path"),
          variables: eb.ref("excluded.variables"),
          attempts: eb.ref("excluded.attempts"),
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
