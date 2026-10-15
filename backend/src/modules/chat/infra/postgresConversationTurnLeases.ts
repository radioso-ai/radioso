import { sql } from "kysely";
import { z } from "zod";

import type { NotificationHandlers } from "../../../shared/infra/postgresNotificationListener.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  ConversationTurnLeaseStore,
  ConversationTurnNotice,
  ConversationTurnNoticeSource,
  ConversationTurnStarted,
} from "../services/crossInstanceConversationTurnRegistry.js";

/** The channel every process listens on; payloads carry ids only, never conversation content. */
const CONVERSATION_TURN_CHANNEL = "radioso_conversation_turns";

/** How long an expired lease is kept before pruning drops it; nothing waits on an expired lease. */
const EXPIRED_LEASE_RETENTION = "5 minutes";

/** At most this many leases, and heads, are pruned per statement. */
const PRUNE_BATCH = 20;

type TurnRef = Parameters<ConversationTurnLeaseStore["end"]>[0];

/**
 * Turn order and leases in `conversation_turn_heads` and `conversation_turn_leases` (migration
 * 226). Starting a turn is one statement that locks only the conversation's own head row. Its turn
 * id is drawn from `conversation_turn_id_seq` under that lock, so a conversation's turn ids grow in
 * the order its turns are placed, and every older turn has a lower id. Cleanup runs in separate,
 * best-effort statements that never wait on a row another statement holds.
 */
export class PostgresConversationTurnLeaseStore implements ConversationTurnLeaseStore {
  constructor(private readonly db: Db) {}

  async begin(input: {
    conversationId: string;
    ownerInstanceId: string;
    supersedeAfterEmission: boolean;
    leaseTtlMs: number;
  }): Promise<{ turnId: string; remoteAhead: boolean; expiredAhead: boolean }> {
    // Every other turn of the conversation that started before this statement's snapshot is
    // visible to it. One that started while this statement waited for the head lock is not; it is
    // then the head this statement replaced (`previous_turn_id`), and its lease row is missing from
    // the snapshot, which `remote_ahead` counts as a live turn ahead. Turns this process started
    // are serialized before this one, so they are always visible.
    const { rows } = await sql<{ turn_id: string; remote_ahead: boolean; expired_ahead: boolean }>`
      WITH head AS (
        INSERT INTO conversation_turn_heads AS h (conversation_id, turn_id, previous_turn_id)
        VALUES (${input.conversationId}::text, nextval('conversation_turn_id_seq'), NULL)
        ON CONFLICT (conversation_id) DO UPDATE
          SET turn_id = nextval('conversation_turn_id_seq'), previous_turn_id = h.turn_id, updated_at = now()
        RETURNING turn_id, previous_turn_id
      ), lease AS (
        INSERT INTO conversation_turn_leases (
          turn_id, conversation_id, owner_instance_id, supersede_after_emission, lease_expires_at
        )
        SELECT head.turn_id, ${input.conversationId}::text, ${input.ownerInstanceId}::text,
          ${input.supersedeAfterEmission}::boolean, now() + ${input.leaseTtlMs}::integer * interval '1 millisecond'
        FROM head
        RETURNING turn_id
      ), announced AS (
        SELECT pg_notify(${CONVERSATION_TURN_CHANNEL}, json_build_object(
          'kind', 'started',
          'conversationId', ${input.conversationId}::text,
          'turnId', lease.turn_id::text,
          'supersedeAfterEmission', ${input.supersedeAfterEmission}::boolean,
          'ownerInstanceId', ${input.ownerInstanceId}::text
        )::text) AS sent
        FROM lease
      )
      SELECT lease.turn_id::text AS turn_id,
        (
          (head.previous_turn_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM conversation_turn_leases previous WHERE previous.turn_id = head.previous_turn_id
          ))
          OR EXISTS (
            SELECT 1 FROM conversation_turn_leases older
            WHERE older.conversation_id = ${input.conversationId}::text
              AND older.turn_id < lease.turn_id
              AND older.owner_instance_id <> ${input.ownerInstanceId}::text
              AND older.lease_expires_at > now()
          )
        ) AS remote_ahead,
        EXISTS (
          SELECT 1 FROM conversation_turn_leases older
          WHERE older.conversation_id = ${input.conversationId}::text
            AND older.turn_id < lease.turn_id
            AND older.owner_instance_id <> ${input.ownerInstanceId}::text
            AND older.lease_expires_at <= now()
        ) AS expired_ahead
      FROM lease CROSS JOIN head CROSS JOIN announced
    `.execute(this.db);
    const row = rows[0];
    if (!row) {
      throw new Error("Expected the conversation turn lease to be recorded");
    }
    return { turnId: row.turn_id, remoteAhead: row.remote_ahead, expiredAhead: row.expired_ahead };
  }

  async end(input: TurnRef): Promise<void> {
    await sql`
      WITH released AS (
        DELETE FROM conversation_turn_leases WHERE turn_id = ${input.turnId}::bigint
      ), head AS (
        DELETE FROM conversation_turn_heads
        WHERE conversation_id = ${input.conversationId}::text AND turn_id = ${input.turnId}::bigint
      )
      SELECT pg_notify(${CONVERSATION_TURN_CHANNEL}, json_build_object(
        'kind', 'ended',
        'conversationId', ${input.conversationId}::text,
        'turnId', ${input.turnId}::text
      )::text)
    `.execute(this.db);
  }

  async renew(input: { ownerInstanceId: string; turnIds: string[]; leaseTtlMs: number }): Promise<string[]> {
    const { rows } = await sql<{ turn_id: string }>`
      WITH renewed AS (
        -- Only a live lease is extended: once expired, successors have stopped waiting for it.
        UPDATE conversation_turn_leases
        SET lease_expires_at = now() + ${input.leaseTtlMs}::integer * interval '1 millisecond'
        WHERE owner_instance_id = ${input.ownerInstanceId}::text
          AND turn_id = ANY(${input.turnIds}::bigint[])
          AND lease_expires_at > now()
        RETURNING turn_id
      ), pruned_leases AS (
        DELETE FROM conversation_turn_leases
        WHERE turn_id IN (
          SELECT turn_id FROM conversation_turn_leases
          WHERE lease_expires_at < now() - ${EXPIRED_LEASE_RETENTION}::interval
          ORDER BY lease_expires_at
          LIMIT ${PRUNE_BATCH}::integer
          FOR UPDATE SKIP LOCKED
        )
      ), pruned_heads AS (
        DELETE FROM conversation_turn_heads
        WHERE conversation_id IN (
          SELECT head.conversation_id FROM conversation_turn_heads head
          WHERE head.updated_at < now() - ${EXPIRED_LEASE_RETENTION}::interval
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turn_leases lease
              WHERE lease.turn_id = head.turn_id
                AND lease.lease_expires_at >= now() - ${EXPIRED_LEASE_RETENTION}::interval
            )
          LIMIT ${PRUNE_BATCH}::integer
          FOR UPDATE SKIP LOCKED
        )
      )
      SELECT held.turn_id::text AS turn_id
      FROM unnest(${input.turnIds}::bigint[]) AS held(turn_id)
      WHERE NOT EXISTS (SELECT 1 FROM renewed WHERE renewed.turn_id = held.turn_id)
    `.execute(this.db);
    return rows.map((row) => row.turn_id);
  }

  async pruneExpired(conversationId: string): Promise<void> {
    await sql`
      WITH pruned_leases AS (
        DELETE FROM conversation_turn_leases
        WHERE turn_id IN (
          SELECT turn_id FROM conversation_turn_leases
          WHERE conversation_id = ${conversationId}::text
            AND lease_expires_at < now() - ${EXPIRED_LEASE_RETENTION}::interval
          LIMIT ${PRUNE_BATCH}::integer
          FOR UPDATE SKIP LOCKED
        )
        RETURNING turn_id
      )
      DELETE FROM conversation_turn_heads
      WHERE conversation_id IN (
        SELECT head.conversation_id FROM conversation_turn_heads head
        WHERE head.conversation_id = ${conversationId}::text
          AND head.turn_id IN (SELECT turn_id FROM pruned_leases)
        FOR UPDATE SKIP LOCKED
      )
    `.execute(this.db);
  }

  async aheadOf(turns: TurnRef[], ownerInstanceId: string): Promise<Map<string, { live: boolean; expired: boolean }>> {
    const { rows } = await sql<{ turn_id: string; live: boolean; expired: boolean }>`
      SELECT waiting.turn_id::text AS turn_id,
        EXISTS (
          SELECT 1 FROM conversation_turn_leases older
          WHERE older.conversation_id = waiting.conversation_id
            AND older.turn_id < waiting.turn_id
            AND older.owner_instance_id <> ${ownerInstanceId}::text
            AND older.lease_expires_at > now()
        ) AS live,
        EXISTS (
          SELECT 1 FROM conversation_turn_leases older
          WHERE older.conversation_id = waiting.conversation_id
            AND older.turn_id < waiting.turn_id
            AND older.owner_instance_id <> ${ownerInstanceId}::text
            AND older.lease_expires_at <= now()
        ) AS expired
      FROM unnest(
        ${turns.map((turn) => turn.turnId)}::bigint[],
        ${turns.map((turn) => turn.conversationId)}::text[]
      ) AS waiting(turn_id, conversation_id)
    `.execute(this.db);
    return new Map(rows.map((row) => [row.turn_id, { live: row.live, expired: row.expired }]));
  }

  async successorsOf(turns: TurnRef[]): Promise<ConversationTurnStarted[]> {
    const { rows } = await sql<{
      conversation_id: string;
      turn_id: string;
      supersede_after_emission: boolean;
      owner_instance_id: string;
    }>`
      SELECT DISTINCT ON (mine.turn_id)
        next.conversation_id, next.turn_id::text AS turn_id, next.supersede_after_emission, next.owner_instance_id
      FROM unnest(
        ${turns.map((turn) => turn.turnId)}::bigint[],
        ${turns.map((turn) => turn.conversationId)}::text[]
      ) AS mine(turn_id, conversation_id)
      JOIN conversation_turn_leases next
        ON next.conversation_id = mine.conversation_id AND next.turn_id > mine.turn_id
      ORDER BY mine.turn_id, next.turn_id
    `.execute(this.db);
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      supersedeAfterEmission: row.supersede_after_emission,
      ownerInstanceId: row.owner_instance_id,
    }));
  }
}

const turnIdSchema = z.string().regex(/^[0-9]+$/);

const noticeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    conversationId: z.string().min(1),
    turnId: turnIdSchema,
    supersedeAfterEmission: z.boolean(),
    ownerInstanceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("ended"),
    conversationId: z.string().min(1),
    turnId: turnIdSchema,
  }),
]);

const parseNotice = (payload: string): ConversationTurnNotice | null => {
  try {
    const parsed = noticeSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Turn announcements, heard through the process's Postgres notification listener. */
export class PostgresConversationTurnNotices implements ConversationTurnNoticeSource {
  constructor(
    private readonly listener: { subscribe(channel: string, handlers: NotificationHandlers): () => void },
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  subscribe(handlers: {
    notice(notice: ConversationTurnNotice): void;
    listening(): void;
    interrupted(): void;
  }): () => void {
    return this.listener.subscribe(CONVERSATION_TURN_CHANNEL, {
      notification: (payload) => {
        const notice = parseNotice(payload);
        if (notice) {
          handlers.notice(notice);
        } else {
          this.logger?.warn({ event: "conversation_turn_notice_unreadable" }, "Conversation turn notice could not be read");
        }
      },
      listening: () => handlers.listening(),
      interrupted: () => handlers.interrupted(),
    });
  }
}
