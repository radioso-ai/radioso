import type {
  ClarificationCandidate,
  ClarificationClearOutcome,
  ConversationClarificationStore,
  PendingClarification,
  PendingClarificationStatus,
  RecentClarificationReader,
} from "@radioso/conversation-contract";

import type { Database } from "../../shared/infra/database.js";

export const DEFAULT_CLARIFICATION_STATE_TTL_MS = 30 * 60 * 1000;

interface ClarificationStateRow {
  session_id: string;
  source: string;
  candidates: unknown;
  asked_event_id: string | null;
  status: string;
  expires_at: Date;
}

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
  candidates: mapCandidates(row.candidates),
  ...(row.asked_event_id ? { askedEventId: row.asked_event_id } : {}),
  status: mapStatus(row.status),
  expiresAt: row.expires_at,
});

export class ClarificationStateRepository implements ConversationClarificationStore, RecentClarificationReader {
  constructor(
    private readonly database: Database,
    private readonly ttlMs: number = DEFAULT_CLARIFICATION_STATE_TTL_MS,
  ) {}

  async loadPending(input: { sessionId: string }): Promise<PendingClarification | null> {
    const row = await this.database.queryOptional<ClarificationStateRow>(
      `SELECT session_id, source, candidates, asked_event_id, status, expires_at
         FROM clarification_states
        WHERE session_id = $1
          AND status = 'pending'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [input.sessionId],
    );
    if (!row) {
      return null;
    }
    if (row.expires_at.getTime() <= Date.now()) {
      await this.database.execute(
        `UPDATE clarification_states
            SET status = 'expired', updated_at = now()
          WHERE session_id = $1`,
        [input.sessionId],
      );
      return null;
    }
    return mapRow(row);
  }

  async loadRecent(input: { sessionId: string }): Promise<PendingClarification | null> {
    const row = await this.database.queryOptional<ClarificationStateRow>(
      `SELECT session_id, source, candidates, asked_event_id, status, expires_at
         FROM clarification_states
        WHERE session_id = $1
          AND status IN ('resolved', 'declined', 'expired')
        ORDER BY updated_at DESC
        LIMIT 1`,
      [input.sessionId],
    );
    if (!row || row.expires_at.getTime() <= Date.now()) {
      return null;
    }
    return mapRow(row);
  }

  async save(pending: PendingClarification): Promise<void> {
    const expiresAt = pending.expiresAt
      ? new Date(pending.expiresAt).toISOString()
      : new Date(Date.now() + this.ttlMs).toISOString();
    await this.database.execute(
      `INSERT INTO clarification_states (session_id, source, candidates, asked_event_id, status, expires_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
       ON CONFLICT (session_id) DO UPDATE SET
         source = EXCLUDED.source,
         candidates = EXCLUDED.candidates,
         asked_event_id = EXCLUDED.asked_event_id,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [
        pending.sessionId,
        pending.source,
        JSON.stringify(pending.candidates),
        pending.askedEventId ?? null,
        pending.status,
        expiresAt,
      ],
    );
  }

  async clear(input: { sessionId: string; outcome?: ClarificationClearOutcome }): Promise<void> {
    await this.database.execute(
      `UPDATE clarification_states
          SET status = $2, updated_at = now()
        WHERE session_id = $1`,
      [input.sessionId, input.outcome ?? "resolved"],
    );
  }
}
