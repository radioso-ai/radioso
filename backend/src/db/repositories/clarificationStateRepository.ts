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
        .set({ status: "expired", original_query: null, updated_at: currentTimestamp() })
        .where("session_id", "=", input.sessionId)
        .execute();
      return null;
    }
    return mapRow(row);
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
    await this.db
      .updateTable("clarification_states")
      .set({ status: input.outcome ?? "resolved", original_query: null, updated_at: currentTimestamp() })
      .where("session_id", "=", input.sessionId)
      .execute();
  }
}
