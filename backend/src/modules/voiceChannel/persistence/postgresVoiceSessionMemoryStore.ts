import { sql } from "kysely";
import { z } from "zod";

import type { NotificationHandlers } from "../../../shared/infra/postgresNotificationListener.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  VoiceSessionArrival,
  VoiceSessionMemoryStore,
  VoiceSessionNoticeSource,
} from "../services/voiceSessionMemory.js";

/** The channel every process listens on; payloads carry an arrival number and a time, nothing else. */
const VOICE_SESSION_CHANNEL = "radioso_voice_sessions";

/** How many forgotten sessions, and expired requests, one settle deletes. */
const PRUNE_BATCH = 20;

/** `last_exchange`: the exchange without its conversation, which has a column of its own. */
const storedExchangeSchema = z.object({
  utteranceDigest: z.string().min(1),
  reply: z.object({ messageId: z.string(), text: z.string() }).nullable(),
  spoken: z.object({ bridge: z.string().nullable(), reply: z.string() }).nullable(),
  cutOffAt: z.number().nullable(),
});

const noteStateSchema = z.enum(["none", "pending", "recorded"]);

interface ArrivalRow {
  session_id: string;
  sequence: string;
  superseded_sequence: string | null;
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
 * What voice sessions remember, in `voice_session_memories` and `voice_session_requests`
 * (migration 227). Arriving is one statement: it locks the session's row, draws the arrival number,
 * forgets an idle session's exchange, registers the request, announces the request it overtook,
 * and reads back what the request needs. Settling is one statement too, and deletes forgotten
 * sessions as it goes.
 */
export class PostgresVoiceSessionMemoryStore implements VoiceSessionMemoryStore {
  constructor(private readonly db: Db) {}

  async arrive(input: Parameters<VoiceSessionMemoryStore["arrive"]>[0]): Promise<VoiceSessionArrival> {
    const { session, now, retention } = input;
    const at = new Date(now);
    const idleBefore = new Date(now - retention.forgetAfterMs);
    const aliveAfter = new Date(now - retention.requestLifetimeMs);
    // Evaluated on the locked row: the session's exchange is forgotten when it has been idle past
    // the memory's lifetime with nothing in flight.
    const forgotten = sql<boolean>`(m.touched_at < ${idleBefore} AND NOT EXISTS (
      SELECT 1 FROM voice_session_requests r
      WHERE r.memory_id = m.id AND r.settled_at IS NULL AND r.arrived_at > ${aliveAfter}
    ))`;
    // Other statements' rows read here are as of this statement's start; the session row itself is
    // read after its lock, so the arrival number and what the row remembers are current.
    const { rows } = await sql<ArrivalRow>`
      WITH arrived AS (
        INSERT INTO voice_session_memories AS m (workspace_id, agent_id, vendor, session_key, newest_sequence, touched_at)
        VALUES (${session.workspaceId}::uuid, ${session.agentId}::uuid, ${session.vendor}, ${session.sessionKey},
          nextval('voice_session_arrival_seq'), ${at})
        ON CONFLICT (agent_id, vendor, session_key) DO UPDATE SET
          previous_sequence = m.newest_sequence,
          newest_sequence = nextval('voice_session_arrival_seq'),
          touched_at = excluded.touched_at,
          last_exchange_sequence = CASE WHEN ${forgotten} THEN NULL ELSE m.last_exchange_sequence END,
          last_exchange_conversation_id = CASE WHEN ${forgotten} THEN NULL ELSE m.last_exchange_conversation_id END,
          last_exchange = CASE WHEN ${forgotten} THEN NULL ELSE m.last_exchange END,
          last_exchange_note = CASE WHEN ${forgotten} THEN 'none' ELSE m.last_exchange_note END
        RETURNING m.*
      ), registered AS (
        INSERT INTO voice_session_requests (sequence, memory_id, arrived_at)
        SELECT newest_sequence, id, ${at} FROM arrived
      ), announced AS (
        SELECT arrived.previous_sequence AS sequence,
          pg_notify(${VOICE_SESSION_CHANNEL}, json_build_object(
            'sequence', arrived.previous_sequence::text,
            'at', ${now}::bigint
          )::text) AS sent
        FROM arrived
        WHERE arrived.previous_sequence IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM voice_session_requests previous
          WHERE previous.sequence = arrived.previous_sequence AND previous.settled_at IS NOT NULL
        )
      )
      SELECT arrived.id::text AS session_id,
        arrived.newest_sequence::text AS sequence,
        (SELECT announced.sequence::text FROM announced) AS superseded_sequence,
        ARRAY(
          SELECT r.sequence::text FROM voice_session_requests r
          WHERE r.memory_id = arrived.id AND r.settled_at IS NULL AND r.arrived_at > ${aliveAfter}
          ORDER BY r.sequence
        ) AS in_flight_sequences,
        arrived.last_bridge_sequence::text AS last_bridge_sequence,
        arrived.last_bridge_at,
        arrived.last_bridge_cut_off,
        arrived.last_exchange_sequence::text AS last_exchange_sequence,
        arrived.last_exchange_conversation_id::text AS last_exchange_conversation_id,
        arrived.last_exchange,
        arrived.last_exchange_note
      FROM arrived
    `.execute(this.db);
    const row = rows[0];
    if (!row) {
      throw new Error("Expected the voice session request to be recorded");
    }
    return {
      sessionId: row.session_id,
      sequence: row.sequence,
      supersededSequence: row.superseded_sequence,
      inFlightSequences: row.in_flight_sequences,
      lastBridge: row.last_bridge_sequence !== null && row.last_bridge_at !== null
        ? { sequence: row.last_bridge_sequence, at: row.last_bridge_at.getTime(), cutOff: row.last_bridge_cut_off }
        : null,
      lastExchange: lastExchangeOf(row),
    };
  }

  async settle(input: Parameters<VoiceSessionMemoryStore["settle"]>[0]): Promise<void> {
    const { sessionId, sequence, now, cutOff, exchange, retention } = input;
    const at = new Date(now);
    const idleBefore = new Date(now - retention.forgetAfterMs);
    const aliveAfter = new Date(now - retention.requestLifetimeMs);
    const stored: z.infer<typeof storedExchangeSchema> | null = exchange
      ? { utteranceDigest: exchange.utteranceDigest, reply: exchange.reply, spoken: exchange.spoken, cutOffAt: exchange.cutOffAt }
      : null;
    const newer = sql<boolean>`(${exchange !== null}::boolean
      AND (m.last_exchange_sequence IS NULL OR m.last_exchange_sequence < ${sequence}::bigint))`;
    await sql`
      WITH settled AS (
        UPDATE voice_session_requests SET settled_at = ${at} WHERE sequence = ${sequence}::bigint
      ), remembered AS (
        UPDATE voice_session_memories m SET
          touched_at = GREATEST(m.touched_at, ${at}),
          last_bridge_cut_off = CASE WHEN m.last_bridge_sequence = ${sequence}::bigint THEN ${cutOff}::boolean
            ELSE m.last_bridge_cut_off END,
          last_exchange_sequence = CASE WHEN ${newer} THEN ${sequence}::bigint ELSE m.last_exchange_sequence END,
          last_exchange_conversation_id = CASE WHEN ${newer} THEN ${exchange?.conversationId ?? null}::uuid
            ELSE m.last_exchange_conversation_id END,
          last_exchange = CASE WHEN ${newer} THEN ${stored === null ? null : JSON.stringify(stored)}::jsonb ELSE m.last_exchange END,
          last_exchange_note = CASE WHEN ${newer} THEN 'none' ELSE m.last_exchange_note END
        WHERE m.id = ${sessionId}::uuid
      ), forgotten AS (
        DELETE FROM voice_session_memories WHERE id IN (
          SELECT idle.id FROM voice_session_memories idle
          WHERE idle.touched_at < ${idleBefore} AND idle.id <> ${sessionId}::uuid AND NOT EXISTS (
            SELECT 1 FROM voice_session_requests r
            WHERE r.memory_id = idle.id AND r.settled_at IS NULL AND r.arrived_at > ${aliveAfter}
          )
          ORDER BY idle.touched_at
          LIMIT ${PRUNE_BATCH}
          FOR UPDATE SKIP LOCKED
        )
      ), expired AS (
        DELETE FROM voice_session_requests WHERE sequence IN (
          SELECT old.sequence FROM voice_session_requests old
          WHERE old.arrived_at <= ${aliveAfter} AND old.sequence <> ${sequence}::bigint
          ORDER BY old.arrived_at
          LIMIT ${PRUNE_BATCH}
          FOR UPDATE SKIP LOCKED
        )
      )
      SELECT 1
    `.execute(this.db);
  }

  async bridgeSpoken(input: Parameters<VoiceSessionMemoryStore["bridgeSpoken"]>[0]): Promise<void> {
    const at = new Date(input.at);
    await this.db
      .updateTable("voice_session_memories")
      .set({
        last_bridge_sequence: input.sequence,
        last_bridge_at: at,
        last_bridge_cut_off: null,
        touched_at: sql<Date>`GREATEST(touched_at, ${at})`,
      })
      .where("id", "=", input.sessionId)
      .where((eb) => eb.or([eb("last_bridge_sequence", "is", null), eb("last_bridge_sequence", "<=", input.sequence)]))
      .execute();
  }

  async claimInterruptionNote(input: Parameters<VoiceSessionMemoryStore["claimInterruptionNote"]>[0]): Promise<boolean> {
    const claimed = await this.db
      .updateTable("voice_session_memories")
      .set({ last_exchange_note: "pending" })
      .where("id", "=", input.sessionId)
      .where("last_exchange_sequence", "=", input.exchangeSequence)
      .where("last_exchange_note", "=", "none")
      .returning("id")
      .executeTakeFirst();
    return claimed !== undefined;
  }

  async releaseInterruptionNote(input: Parameters<VoiceSessionMemoryStore["releaseInterruptionNote"]>[0]): Promise<void> {
    await this.db
      .updateTable("voice_session_memories")
      .set({ last_exchange_note: input.recorded ? "recorded" : "none" })
      .where("id", "=", input.sessionId)
      .where("last_exchange_sequence", "=", input.exchangeSequence)
      .where("last_exchange_note", "=", "pending")
      .execute();
  }

  async supersededAt(sequences: string[]): Promise<Map<string, number>> {
    if (sequences.length === 0) {
      return new Map();
    }
    const { rows } = await sql<{ sequence: string; superseded_at: Date }>`
      SELECT request.sequence::text AS sequence, next.arrived_at AS superseded_at
      FROM voice_session_requests request
      CROSS JOIN LATERAL (
        SELECT newer.arrived_at FROM voice_session_requests newer
        WHERE newer.memory_id = request.memory_id AND newer.sequence > request.sequence
        ORDER BY newer.sequence
        LIMIT 1
      ) next
      WHERE request.sequence = ANY(${sequences}::bigint[])
    `.execute(this.db);
    return new Map(rows.map((row) => [row.sequence, row.superseded_at.getTime()]));
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
