import type { ConversationRoutineStore, RoutineState } from "@radioso/conversation-contract";

import type { Database } from "../../shared/infra/database.js";

interface RoutineStateRow {
  // SQL rows keep database column names; the repository maps to the contract record.
  session_id: string;
  routine_id: string;
  path: string[] | null;
  variables: Record<string, unknown> | null;
  status: string;
  expires_at: Date | null;
}

const mapState = (row: RoutineStateRow): RoutineState => ({
  sessionId: row.session_id,
  routineId: row.routine_id,
  path: row.path ?? [],
  variables: row.variables ?? {},
  status: (row.status as RoutineState["status"]) ?? "active",
});

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Generic DB-backed {@link ConversationRoutineStore}: at most one in-flight routine
 * per session, resumed from its `path` + `variables` and cleared on completion. It
 * owns expiry (TTL) — `loadActive` never returns an expired flow — so the engine
 * never resumes an abandoned routine. Not specific to any routine; any registered
 * routine persists here.
 */
export class RoutineStateRepository implements ConversationRoutineStore {
  constructor(
    private readonly database: Database,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async loadActive(input: { sessionId: string }): Promise<RoutineState | null> {
    const row = await this.database.queryOptional<RoutineStateRow>(
      `SELECT session_id, routine_id, path, variables, status, expires_at
         FROM routine_states
        WHERE session_id = $1
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())`,
      [input.sessionId],
    );
    return row ? mapState(row) : null;
  }

  async save(state: RoutineState): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    // One row per session — advancing a routine upserts; an expired row is overwritten
    // when a fresh routine activates for the same session.
    await this.database.execute(
      `INSERT INTO routine_states (session_id, routine_id, path, variables, status, expires_at, updated_at)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6, now())
       ON CONFLICT (session_id) DO UPDATE SET
         routine_id = EXCLUDED.routine_id,
         path = EXCLUDED.path,
         variables = EXCLUDED.variables,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [state.sessionId, state.routineId, state.path, JSON.stringify(state.variables), state.status, expiresAt],
    );
  }

  async clear(input: { sessionId: string }): Promise<void> {
    await this.database.execute(`DELETE FROM routine_states WHERE session_id = $1`, [input.sessionId]);
  }
}
