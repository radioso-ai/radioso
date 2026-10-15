import { sql, type RawBuilder } from "kysely";
import { z } from "zod";

import type { NotificationHandlers } from "../../../shared/infra/postgresNotificationListener.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  VoiceSessionArrival,
  VoiceSessionMemoryStore,
  VoiceSessionNoticeSource,
  VoiceSessionRetention,
} from "../services/voiceSessionMemory.js";

/** The channel every process listens on; payloads carry an arrival number and a time, nothing else. */
const VOICE_SESSION_CHANNEL = "radioso_voice_sessions";

/** How many forgotten sessions one settle deletes. */
const PRUNE_BATCH = 20;

/** `last_exchange`: the exchange without its conversation, which has a column of its own. */
const storedExchangeSchema = z.object({
  utteranceDigest: z.string().min(1),
  reply: z.object({ messageId: z.string(), text: z.string() }).nullable(),
  spoken: z.object({ bridge: z.string().nullable(), reply: z.string() }).nullable(),
  cutOffAt: z.number().nullable(),
});

const noteStateSchema = z.enum(["none", "pending", "recorded"]);

/** Epoch milliseconds of a timestamp expression, as the `requests` map and notices hold them. */
const epochMs = (timestamp: RawBuilder<unknown>): RawBuilder<number> =>
  sql<number>`floor(extract(epoch FROM ${timestamp}) * 1000)::bigint`;

const milliseconds = (ms: number): RawBuilder<unknown> => sql`(${ms}::integer * interval '1 millisecond')`;

/** The requests of `requests` still alive at `nowMs`: unsettled ones younger than a request lives. */
const liveRequests = (requests: RawBuilder<unknown>, nowMs: RawBuilder<number>, retention: VoiceSessionRetention) =>
  sql<unknown>`(
    SELECT coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    FROM jsonb_each(${requests}) entry
    WHERE (entry.value->>'arrivedAt')::bigint > ${nowMs} - ${retention.requestLifetimeMs}::bigint
  )`;

interface ArrivalRow {
  session_id: string;
  sequence: string;
  in_flight_sequences: string[];
  last_bridge_sequence: string | null;
  last_bridge_at: Date | null;
  last_bridge_cut_off: boolean | null;
  last_exchange_sequence: string | null;
  last_exchange_conversation_id: string | null;
  last_exchange: unknown;
  last_exchange_note: string;
}

const lastExchangeOf = (row: ArrivalRow): VoiceSessionArrival["lastExchange"] => {
  if (row.last_exchange_sequence === null || row.last_exchange_conversation_id === null) {
    return null;
  }
  const stored = storedExchangeSchema.safeParse(row.last_exchange);
  if (!stored.success) {
    return null;
  }
  return {
    sequence: row.last_exchange_sequence,
    exchange: { ...stored.data, conversationId: row.last_exchange_conversation_id },
    note: noteStateSchema.parse(row.last_exchange_note),
  };
};

/**
 * What voice sessions remember for the instances that share them, in `voice_session_memories`
 * (migration 227). Every write locks the session's row, and what it decides it reads from that
 * locked row, never from the statement's snapshot, so two instances' writes to one session are
 * ordered. Arriving is one statement: it draws the arrival number and the arrival time on the
 * database's clock under the lock, marks the request before it overtaken, forgets an idle session's
 * exchange, registers the request, announces the overtaken request, and reads back what the request
 * needs. Settling is one statement too, and deletes forgotten sessions as it goes.
 */
export class PostgresVoiceSessionMemoryStore implements VoiceSessionMemoryStore {
  constructor(private readonly db: Db) {}

  async arrive(input: Parameters<VoiceSessionMemoryStore["arrive"]>[0]): Promise<VoiceSessionArrival> {
    const { session, instanceId, retention } = input;
    const nextMs = epochMs(sql`next.at`);
    const live = liveRequests(sql`m.requests`, nextMs, retention);
    const { rows } = await sql<ArrivalRow>`
      WITH first_arrival AS (
        SELECT nextval('voice_session_arrival_seq') AS sequence, clock_timestamp() AS at
      ), arrived AS (
        INSERT INTO voice_session_memories AS m (workspace_id, agent_id, vendor, session_key, newest_sequence, touched_at, requests)
        SELECT ${session.workspaceId}::uuid, ${session.agentId}::uuid, ${session.vendor}, ${session.sessionKey},
          first_arrival.sequence, first_arrival.at,
          jsonb_build_object(first_arrival.sequence::text,
            jsonb_build_object('arrivedAt', ${epochMs(sql`first_arrival.at`)}, 'instance', ${instanceId}::text))
        FROM first_arrival
        ON CONFLICT (agent_id, vendor, session_key) DO UPDATE SET
          -- Evaluated once the row is locked: the number, the time and what the row holds are current.
          (previous_sequence, newest_sequence, touched_at, requests,
            last_exchange_sequence, last_exchange_conversation_id, last_exchange,
            last_exchange_note, last_exchange_note_owner, last_exchange_note_claimed_at) = (
            SELECT m.newest_sequence, next.sequence, GREATEST(m.touched_at, next.at),
              -- The request before this one is overtaken by it, when it is still in flight.
              (SELECT coalesce(jsonb_object_agg(entry.key, CASE WHEN entry.key = m.newest_sequence::text
                  THEN entry.value || jsonb_build_object('supersededAt', ${nextMs}, 'supersededBy', ${instanceId}::text)
                  ELSE entry.value END), '{}'::jsonb)
                FROM jsonb_each(still.requests) entry)
                || jsonb_build_object(next.sequence::text, jsonb_build_object('arrivedAt', ${nextMs}, 'instance', ${instanceId}::text)),
              CASE WHEN idle.forgotten THEN NULL ELSE m.last_exchange_sequence END,
              CASE WHEN idle.forgotten THEN NULL ELSE m.last_exchange_conversation_id END,
              CASE WHEN idle.forgotten THEN NULL ELSE m.last_exchange END,
              CASE WHEN idle.forgotten THEN 'none' ELSE m.last_exchange_note END,
              CASE WHEN idle.forgotten THEN NULL ELSE m.last_exchange_note_owner END,
              CASE WHEN idle.forgotten THEN NULL ELSE m.last_exchange_note_claimed_at END
            FROM (SELECT nextval('voice_session_arrival_seq') AS sequence, clock_timestamp() AS at) next
            CROSS JOIN LATERAL (SELECT ${live} AS requests) still
            CROSS JOIN LATERAL (
              SELECT (m.touched_at < next.at - ${milliseconds(retention.forgetAfterMs)} AND still.requests = '{}'::jsonb) AS forgotten
            ) idle
          )
        RETURNING m.*
      ), announced AS (
        SELECT pg_notify(${VOICE_SESSION_CHANNEL}, json_build_object(
          'sequence', arrived.previous_sequence::text,
          'at', (arrived.requests -> arrived.previous_sequence::text ->> 'supersededAt')::bigint
        )::text) AS sent
        FROM arrived
        WHERE arrived.previous_sequence IS NOT NULL AND arrived.requests ? arrived.previous_sequence::text
      )
      SELECT arrived.id::text AS session_id,
        arrived.newest_sequence::text AS sequence,
        ARRAY(
          SELECT key FROM jsonb_object_keys(arrived.requests) key
          WHERE key <> arrived.newest_sequence::text
          ORDER BY key::bigint
        ) AS in_flight_sequences,
        arrived.last_bridge_sequence::text AS last_bridge_sequence,
        arrived.last_bridge_at,
        arrived.last_bridge_cut_off,
        arrived.last_exchange_sequence::text AS last_exchange_sequence,
        arrived.last_exchange_conversation_id::text AS last_exchange_conversation_id,
        arrived.last_exchange,
        -- A claim its owner never released lapses, so the note may be written again.
        CASE WHEN arrived.last_exchange_note = 'pending'
            AND arrived.last_exchange_note_claimed_at < clock_timestamp() - ${milliseconds(retention.noteClaimLifetimeMs)}
          THEN 'none' ELSE arrived.last_exchange_note END AS last_exchange_note,
        (SELECT count(*) FROM announced) AS announced
      FROM arrived
    `.execute(this.db);
    const row = rows[0];
    if (!row) {
      throw new Error("Expected the voice session request to be recorded");
    }
    return {
      sessionId: row.session_id,
      sequence: row.sequence,
      inFlightSequences: row.in_flight_sequences,
      lastBridge: row.last_bridge_sequence !== null && row.last_bridge_at !== null
        ? { sequence: row.last_bridge_sequence, at: row.last_bridge_at.getTime(), cutOff: row.last_bridge_cut_off }
        : null,
      lastExchange: lastExchangeOf(row),
    };
  }

  async settle(input: Parameters<VoiceSessionMemoryStore["settle"]>[0]): Promise<void> {
    const { sessionId, sequence, cutOff, exchange, retention } = input;
    const stored: z.infer<typeof storedExchangeSchema> | null = exchange
      ? { utteranceDigest: exchange.utteranceDigest, reply: exchange.reply, spoken: exchange.spoken, cutOffAt: exchange.cutOffAt }
      : null;
    const newer = sql<boolean>`(${exchange !== null}::boolean
      AND (m.last_exchange_sequence IS NULL OR m.last_exchange_sequence < ${sequence}::bigint))`;
    const nowMs = epochMs(sql`clock_timestamp()`);
    await sql`
      WITH remembered AS (
        UPDATE voice_session_memories m SET
          requests = m.requests - ${sequence}::text,
          touched_at = GREATEST(m.touched_at, clock_timestamp()),
          last_bridge_cut_off = CASE WHEN m.last_bridge_sequence = ${sequence}::bigint THEN ${cutOff}::boolean
            ELSE m.last_bridge_cut_off END,
          last_exchange_sequence = CASE WHEN ${newer} THEN ${sequence}::bigint ELSE m.last_exchange_sequence END,
          last_exchange_conversation_id = CASE WHEN ${newer} THEN ${exchange?.conversationId ?? null}::uuid
            ELSE m.last_exchange_conversation_id END,
          last_exchange = CASE WHEN ${newer} THEN ${stored === null ? null : JSON.stringify(stored)}::jsonb ELSE m.last_exchange END,
          last_exchange_note = CASE WHEN ${newer} THEN 'none' ELSE m.last_exchange_note END,
          last_exchange_note_owner = CASE WHEN ${newer} THEN NULL ELSE m.last_exchange_note_owner END,
          last_exchange_note_claimed_at = CASE WHEN ${newer} THEN NULL ELSE m.last_exchange_note_claimed_at END
        WHERE m.id = ${sessionId}::uuid
      ), forgotten AS (
        DELETE FROM voice_session_memories WHERE id IN (
          SELECT idle.id FROM voice_session_memories idle
          WHERE idle.touched_at < clock_timestamp() - ${milliseconds(retention.forgetAfterMs)}
            AND idle.id <> ${sessionId}::uuid
            AND ${liveRequests(sql`idle.requests`, nowMs, retention)} = '{}'::jsonb
          ORDER BY idle.touched_at
          LIMIT ${PRUNE_BATCH}
          FOR UPDATE SKIP LOCKED
        )
      )
      SELECT 1
    `.execute(this.db);
  }

  async claimBridge(input: Parameters<VoiceSessionMemoryStore["claimBridge"]>[0]): Promise<boolean> {
    const { sessionId, sequence, instanceId } = input;
    const latest = sql<boolean>`(m.last_bridge_sequence IS NULL OR m.last_bridge_sequence <= ${sequence}::bigint)`;
    const { rows } = await sql<{ claimed: number }>`
      UPDATE voice_session_memories m SET
        last_bridge_sequence = CASE WHEN ${latest} THEN ${sequence}::bigint ELSE m.last_bridge_sequence END,
        last_bridge_at = CASE WHEN ${latest} THEN clock_timestamp() ELSE m.last_bridge_at END,
        last_bridge_cut_off = CASE WHEN ${latest} THEN NULL ELSE m.last_bridge_cut_off END,
        touched_at = GREATEST(m.touched_at, clock_timestamp())
      WHERE m.id = ${sessionId}::uuid
        AND m.requests ? ${sequence}::text
        AND coalesce(m.requests -> ${sequence}::text ->> 'supersededBy', ${instanceId}::text) = ${instanceId}::text
      RETURNING 1 AS claimed
    `.execute(this.db);
    return rows.length > 0;
  }

  async claimInterruptionNote(input: Parameters<VoiceSessionMemoryStore["claimInterruptionNote"]>[0]): Promise<boolean> {
    const { sessionId, exchangeSequence, owner, retention } = input;
    const { rows } = await sql<{ claimed: number }>`
      UPDATE voice_session_memories SET
        last_exchange_note = 'pending',
        last_exchange_note_owner = ${owner},
        last_exchange_note_claimed_at = clock_timestamp()
      WHERE id = ${sessionId}::uuid
        AND last_exchange_sequence = ${exchangeSequence}::bigint
        AND (last_exchange_note = 'none' OR (last_exchange_note = 'pending'
          AND last_exchange_note_claimed_at < clock_timestamp() - ${milliseconds(retention.noteClaimLifetimeMs)}))
      RETURNING 1 AS claimed
    `.execute(this.db);
    return rows.length > 0;
  }

  async releaseInterruptionNote(input: Parameters<VoiceSessionMemoryStore["releaseInterruptionNote"]>[0]): Promise<void> {
    await this.db
      .updateTable("voice_session_memories")
      .set({
        last_exchange_note: input.recorded ? "recorded" : "none",
        last_exchange_note_owner: null,
        last_exchange_note_claimed_at: null,
      })
      .where("id", "=", input.sessionId)
      .where("last_exchange_sequence", "=", input.exchangeSequence)
      .where("last_exchange_note", "=", "pending")
      .where("last_exchange_note_owner", "=", input.owner)
      .execute();
  }

  async supersededAt(requests: Array<{ sessionId: string; sequence: string }>): Promise<Map<string, number>> {
    if (requests.length === 0) {
      return new Map();
    }
    const { rows } = await sql<{ sequence: string; superseded_at: string }>`
      SELECT entry.key AS sequence, entry.value ->> 'supersededAt' AS superseded_at
      FROM voice_session_memories m
      CROSS JOIN LATERAL jsonb_each(m.requests) entry
      WHERE m.id = ANY(${[...new Set(requests.map((request) => request.sessionId))]}::uuid[])
        AND entry.key = ANY(${requests.map((request) => request.sequence)}::text[])
        AND entry.value ? 'supersededAt'
    `.execute(this.db);
    return new Map(rows.map((row) => [row.sequence, Number(row.superseded_at)]));
  }
}

const noticeSchema = z.object({
  sequence: z.string().regex(/^\d+$/u),
  at: z.number().int(),
});

/** Supersession announcements, heard through the process's Postgres notification listener. */
export class PostgresVoiceSessionNotices implements VoiceSessionNoticeSource {
  constructor(
    private readonly listener: { subscribe(channel: string, handlers: NotificationHandlers): () => void },
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  subscribe(handlers: Parameters<VoiceSessionNoticeSource["subscribe"]>[0]): () => void {
    return this.listener.subscribe(VOICE_SESSION_CHANNEL, {
      notification: (payload) => {
        const notice = parseNotice(payload);
        if (notice) {
          handlers.superseded(notice);
        } else {
          this.logger?.warn({ event: "voice_session_notice_unreadable" }, "Voice session notice could not be read");
        }
      },
      listening: () => handlers.listening(),
      interrupted: () => handlers.interrupted(),
    });
  }
}

const parseNotice = (payload: string): { sequence: string; at: number } | null => {
  try {
    const parsed = noticeSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
