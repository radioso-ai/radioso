import { sql } from "kysely";
import { z } from "zod";

import type { NotificationHandlers } from "../../../shared/infra/postgresNotificationListener.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type {
  ConversationTurnLeaseGrant,
  ConversationTurnLeaseStore,
  ConversationTurnNotice,
  ConversationTurnNoticeSource,
  ConversationTurnStarted,
} from "../services/crossInstanceConversationTurnRegistry.js";

/** The channel every process listens on; payloads carry ids only, never conversation content. */
const CONVERSATION_TURN_CHANNEL = "radioso_conversation_turns";

/** How long an expired lease is kept, so a waiting successor can tell a takeover from an end. */
const EXPIRED_LEASE_RETENTION = "5 minutes";

/** At most this many leases, and heads, are pruned per statement, so pruning never grows a turn's start. */
const PRUNE_BATCH = 20;

/**
 * Drops a bounded batch of leases expired longer than the retention, and heads left pointing at no
 * live-enough lease. `SKIP LOCKED` keeps it from ever waiting on a row another statement holds, so
 * it adds no lock wait (and no deadlock) to the statement it rides on. `exceptConversationId` keeps
 * a starting turn's own head out of it: the same statement upserts that row.
 */
const pruneExpiredLeases = (exceptConversationId: string | null) => sql`
  pruned_leases AS (
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
        AND head.conversation_id IS DISTINCT FROM ${exceptConversationId}::text
        AND NOT EXISTS (
          SELECT 1 FROM conversation_turn_leases lease
          WHERE lease.turn_id = head.turn_id
            AND lease.lease_expires_at >= now() - ${EXPIRED_LEASE_RETENTION}::interval
        )
      LIMIT ${PRUNE_BATCH}::integer
      FOR UPDATE SKIP LOCKED
    )
  )`;

/**
 * Turn order and leases in `conversation_turn_heads` and `conversation_turn_leases` (migration
 * 226). Starting a turn is one statement: it locks the conversation's head row, links the new turn
 * to the latest one, records the lease, announces it, and prunes a bounded batch of leases left by
 * crashed processes.
 */
export class PostgresConversationTurnLeaseStore implements ConversationTurnLeaseStore {
  constructor(private readonly db: Db) {}

  async begin(input: {
    conversationId: string;
    ownerInstanceId: string;
    supersedeAfterEmission: boolean;
    leaseTtlMs: number;
  }): Promise<ConversationTurnLeaseGrant> {
    // The head upsert waits on a concurrent start's row lock and then sees its turn, so the two
    // are ordered. The predecessor's lease row may be invisible to this statement's snapshot when
    // that start committed meanwhile; such a predecessor is fresh, so only a visibly expired lease
    // counts as expired.
    const { rows } = await sql<{ turn_id: string; predecessor_turn_id: string | null; predecessor_expired: boolean }>`
      WITH ${pruneExpiredLeases(input.conversationId)}, next_turn AS (
        SELECT nextval('conversation_turn_id_seq') AS turn_id
      ), head AS (
        INSERT INTO conversation_turn_heads AS h (conversation_id, turn_id, predecessor_turn_id)
        SELECT ${input.conversationId}::text, next_turn.turn_id, NULL::bigint FROM next_turn
        ON CONFLICT (conversation_id) DO UPDATE
          SET turn_id = excluded.turn_id, predecessor_turn_id = h.turn_id, updated_at = now()
        RETURNING turn_id, predecessor_turn_id
      ), lease AS (
        INSERT INTO conversation_turn_leases (
          turn_id, conversation_id, predecessor_turn_id, owner_instance_id, supersede_after_emission, lease_expires_at
        )
        SELECT head.turn_id, ${input.conversationId}::text, head.predecessor_turn_id, ${input.ownerInstanceId}::text,
          ${input.supersedeAfterEmission}::boolean, now() + ${input.leaseTtlMs}::integer * interval '1 millisecond'
        FROM head
        RETURNING turn_id, predecessor_turn_id
      ), announced AS (
        SELECT pg_notify(${CONVERSATION_TURN_CHANNEL}, json_build_object(
          'kind', 'started',
          'conversationId', ${input.conversationId}::text,
          'turnId', lease.turn_id::text,
          'predecessorTurnId', lease.predecessor_turn_id::text,
          'supersedeAfterEmission', ${input.supersedeAfterEmission}::boolean,
          'ownerInstanceId', ${input.ownerInstanceId}::text
        )::text) AS sent
        FROM lease
      )
      SELECT lease.turn_id::text AS turn_id,
        lease.predecessor_turn_id::text AS predecessor_turn_id,
        EXISTS (
          SELECT 1 FROM conversation_turn_leases predecessor
          WHERE predecessor.turn_id = lease.predecessor_turn_id AND predecessor.lease_expires_at <= now()
        ) AS predecessor_expired
      FROM lease CROSS JOIN announced
    `.execute(this.db);
    const row = rows[0];
    if (!row) {
      throw new Error("Expected the conversation turn lease to be recorded");
    }
    return {
      turnId: row.turn_id,
      predecessorTurnId: row.predecessor_turn_id,
      predecessorExpired: row.predecessor_expired,
    };
  }

  async end(input: { conversationId: string; turnId: string }): Promise<void> {
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
      ), ${pruneExpiredLeases(null)}
      SELECT held.turn_id::text AS turn_id
      FROM unnest(${input.turnIds}::bigint[]) AS held(turn_id)
      WHERE NOT EXISTS (SELECT 1 FROM renewed WHERE renewed.turn_id = held.turn_id)
    `.execute(this.db);
    return rows.map((row) => row.turn_id);
  }

  async leaseStates(turnIds: string[]): Promise<Map<string, { live: boolean; predecessorTurnId: string | null }>> {
    const { rows } = await sql<{ turn_id: string; live: boolean; predecessor_turn_id: string | null }>`
      SELECT turn_id::text AS turn_id, lease_expires_at > now() AS live, predecessor_turn_id::text AS predecessor_turn_id
      FROM conversation_turn_leases
      WHERE turn_id = ANY(${turnIds}::bigint[])
    `.execute(this.db);
    return new Map(rows.map((row) => [row.turn_id, { live: row.live, predecessorTurnId: row.predecessor_turn_id }]));
  }

  async successorsOf(turnIds: string[]): Promise<ConversationTurnStarted[]> {
    const { rows } = await sql<{
      conversation_id: string;
      turn_id: string;
      predecessor_turn_id: string;
      supersede_after_emission: boolean;
      owner_instance_id: string;
    }>`
      SELECT conversation_id, turn_id::text AS turn_id, predecessor_turn_id::text AS predecessor_turn_id,
        supersede_after_emission, owner_instance_id
      FROM conversation_turn_leases
      WHERE predecessor_turn_id = ANY(${turnIds}::bigint[])
    `.execute(this.db);
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      predecessorTurnId: row.predecessor_turn_id,
      supersedeAfterEmission: row.supersede_after_emission,
      ownerInstanceId: row.owner_instance_id,
    }));
  }
}

const noticeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
    predecessorTurnId: z.string().min(1).nullable(),
    supersedeAfterEmission: z.boolean(),
    ownerInstanceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("ended"),
    conversationId: z.string().min(1),
    turnId: z.string().min(1),
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
