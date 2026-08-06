import type {
  ClarificationCandidate,
  ClarificationClearOutcome,
  ConversationClarificationStore,
  PendingClarification,
  PendingClarificationStatus,
  RecentClarificationReader,
} from "@radioso/conversation-contract";

import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export const DEFAULT_CLARIFICATION_STATE_TTL_MS = 30 * 60 * 1000;

interface ClarificationStateRow {
  session_id: string;
  source: string;
  original_query: string | null;
  mode: string | null;
  candidates: unknown;
  asked_event_id: string | null;
  status: string;
  expires_at: Date;
}

const clarificationColumns = [
  "session_id",
  "source",
  "original_query",
  "mode",
  "candidates",
  "asked_event_id",
  "status",
  "expires_at",
] as const;

const isCandidate = (value: unknown): value is ClarificationCandidate => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.confidence === "number" &&
    "payload" in candidate;
};

const mapCandidates = (value: unknown): ClarificationCandidate[] =>
  Array.isArray(value) ? value.filter(isCandidate) : [];

/**
 * True when `mapCandidates` silently dropped one or more malformed entries.
 * `save()` only ever persists well-formed candidates, so this indicates the
 * stored row is corrupt relative to what the visitor was shown — the
 * surviving candidates would otherwise renumber and no longer line up with
 * the position the visitor saw. Detected only for `loadPending`, where reply
 * matching depends on that position; `loadRecent` only ever compares
 * candidate id *sets* for the loop guard, which a drop cannot mis-order.
 */
const candidatesWereTruncatedOnRead = (raw: unknown, mapped: ClarificationCandidate[]): boolean =>
  Array.isArray(raw) && raw.length !== mapped.length;

const mapStatus = (status: string): PendingClarificationStatus =>
  status === "resolved" || status === "declined" || status === "expired"
    ? status
    : "pending";

const mapRow = (row: ClarificationStateRow): PendingClarification => ({
  sessionId: row.session_id,
  source: row.source,
  ...(row.original_query ? { originalQuery: row.original_query } : {}),
  mode: row.mode === "offer" ? "offer" : "ask",
  candidates: mapCandidates(row.candidates),
  ...(row.asked_event_id ? { askedEventId: row.asked_event_id } : {}),
  status: mapStatus(row.status),
  expiresAt: row.expires_at,
});

/**
 * `original_query` is retained on a `declined`/`expired` clear so a failed
 * mapping stays debuggable and a later turn could recover the question; only
 * a `resolved` clear nulls it, since `resolvePendingClarification` already
 * reads `pending.originalQuery` and hands it to the caller before clearing,
 * so nothing is left to recover for that outcome. This only changes what is
 * retained in storage — it does not change what gets retried or retrieved on
 * a failed mapping, which stays a separate behavioral decision.
 */
const clearedFields = (outcome: ClarificationClearOutcome): { original_query: null } | Record<string, never> =>
  outcome === "resolved" ? { original_query: null } : {};

export class ClarificationStateRepository implements ConversationClarificationStore, RecentClarificationReader {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = DEFAULT_CLARIFICATION_STATE_TTL_MS,
  ) {}

  async loadPending(input: { sessionId: string }): Promise<PendingClarification | null> {
    const row = await this.db
      .selectFrom("clarification_states")
      .select(clarificationColumns)
      .where("session_id", "=", input.sessionId)
      .where("status", "=", "pending")
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    if (row.expires_at.getTime() <= Date.now()) {
      await this.db
        .updateTable("clarification_states")
        .set({ status: "expired", ...clearedFields("expired"), updated_at: currentTimestamp() })
        .where("session_id", "=", input.sessionId)
        .execute();
      return null;
    }
    const pending = mapRow(row);
    if (candidatesWereTruncatedOnRead(row.candidates, pending.candidates)) {
      // Fail closed rather than matching (deterministically or via the LLM
      // mapper) against a row whose candidate order can no longer be trusted.
      return null;
    }
    return pending;
  }

  async loadRecent(input: { sessionId: string }): Promise<PendingClarification | null> {
    const row = await this.db
      .selectFrom("clarification_states")
      .select(clarificationColumns)
      .where("session_id", "=", input.sessionId)
      .where("status", "in", ["resolved", "declined", "expired"])
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row || row.expires_at.getTime() <= Date.now()) {
      return null;
    }
    return mapRow(row);
  }

  async save(pending: PendingClarification): Promise<void> {
    const expiresAt = pending.expiresAt
      ? new Date(pending.expiresAt)
      : new Date(Date.now() + this.ttlMs);
    await this.db
      .insertInto("clarification_states")
      .values({
        session_id: pending.sessionId,
        source: pending.source,
        original_query: pending.originalQuery ?? null,
        mode: pending.mode ?? "ask",
        candidates: toJsonb(pending.candidates),
        asked_event_id: pending.askedEventId ?? null,
        status: pending.status,
        expires_at: expiresAt,
        updated_at: currentTimestamp(),
      })
      .onConflict((oc) =>
        oc.column("session_id").doUpdateSet((eb) => ({
          source: eb.ref("excluded.source"),
          original_query: eb.ref("excluded.original_query"),
          mode: eb.ref("excluded.mode"),
          candidates: eb.ref("excluded.candidates"),
          asked_event_id: eb.ref("excluded.asked_event_id"),
          status: eb.ref("excluded.status"),
          expires_at: eb.ref("excluded.expires_at"),
          updated_at: currentTimestamp(),
        })),
      )
      .execute();
  }

  async clear(input: { sessionId: string; outcome?: ClarificationClearOutcome }): Promise<void> {
    const outcome = input.outcome ?? "resolved";
    await this.db
      .updateTable("clarification_states")
      .set({ status: outcome, ...clearedFields(outcome), updated_at: currentTimestamp() })
      .where("session_id", "=", input.sessionId)
      .execute();
  }
}
