import type { DirectiveFiring, DirectiveFiringState, DirectiveStateStore } from "../../modules/directives/public.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface DirectiveStateRow {
  session_id: string;
  turn_seq: number;
  firings: Record<string, unknown> | null;
  expires_at: Date | null;
}

const directiveStateColumns = ["session_id", "turn_seq", "firings", "expires_at"] as const;

const mapFirings = (value: Record<string, unknown> | null): Record<string, DirectiveFiring> => {
  if (!value) {
    return {};
  }
  const firings: Record<string, DirectiveFiring> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const lastFiredTurn = (raw as { lastFiredTurn?: unknown }).lastFiredTurn;
    const count = (raw as { count?: unknown }).count;
    if (
      typeof lastFiredTurn === "number" &&
      Number.isFinite(lastFiredTurn) &&
      typeof count === "number" &&
      Number.isFinite(count)
    ) {
      firings[name] = { lastFiredTurn, count };
    }
  }
  return firings;
};

const mapState = (row: DirectiveStateRow): DirectiveFiringState => ({
  turnSeq: typeof row.turn_seq === "number" && Number.isFinite(row.turn_seq) ? row.turn_seq : 0,
  firings: mapFirings(row.firings),
});

export const DEFAULT_DIRECTIVE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * DB-backed {@link DirectiveStateStore}: one row per conversation holding the
 * directive firing memory that suppresses once/cooldown re-fires. Owns expiry
 * (TTL) so an abandoned conversation's memory is eventually reclaimed and a
 * revived conversation starts fresh rather than resurrecting stale firings.
 */
export class DirectiveStateRepository implements DirectiveStateStore {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = DEFAULT_DIRECTIVE_STATE_TTL_MS,
  ) {}

  async load(input: { sessionId: string }): Promise<DirectiveFiringState | null> {
    const row = await this.db
      .selectFrom("directive_states")
      .select(directiveStateColumns)
      .where("session_id", "=", input.sessionId)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", currentTimestamp())]))
      .executeTakeFirst();
    return row ? mapState(row as DirectiveStateRow) : null;
  }

  async save(input: { sessionId: string; state: DirectiveFiringState }): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    // One row per conversation — each committed turn upserts the advanced state.
    await this.db
      .insertInto("directive_states")
      .values({
        session_id: input.sessionId,
        turn_seq: input.state.turnSeq,
        firings: toJsonb(input.state.firings),
        expires_at: expiresAt,
        updated_at: currentTimestamp(),
      })
      .onConflict((oc) =>
        oc.column("session_id").doUpdateSet((eb) => ({
          turn_seq: eb.ref("excluded.turn_seq"),
          firings: eb.ref("excluded.firings"),
          expires_at: eb.ref("excluded.expires_at"),
          updated_at: currentTimestamp(),
        })),
      )
      .execute();
  }
}
