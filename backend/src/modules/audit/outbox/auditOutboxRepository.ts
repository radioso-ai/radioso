import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import { clockTimestamp, toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type {
  AuditOutboxClaim,
  AuditOutboxIntent,
  AuditOutboxRepositoryPort,
  ClaimedAuditOutboxEntry,
} from "./ports.js";

/** The generic transactional outbox's own row shape, before a claim's mapping. */
interface AuditOutboxClaimRow {
  id: string;
  account_id: string | null;
  workspace_id: string | null;
  event_type: string;
  event_status: string;
  metadata_json: unknown;
  attempt_count: number;
  workspace_present: boolean;
}

/**
 * The Postgres-backed `audit_outbox`. Every caller depends on `enqueue` alone;
 * `claim` and `acknowledge` exist for the dispatcher this module also owns, and
 * nothing outside it uses them.
 */
export class AuditOutboxRepository implements AuditOutboxRepositoryPort {
  constructor(private readonly db: Kysely<DB>) {}

  async enqueue(executor: Kysely<DB>, intents: readonly AuditOutboxIntent[]): Promise<readonly string[]> {
    if (intents.length === 0) return [];

    const rows = await executor
      .insertInto("audit_outbox")
      .values(
        intents.map((intent) => ({
          account_id: intent.accountId,
          workspace_id: intent.workspaceId,
          event_type: intent.eventType,
          event_status: intent.eventStatus,
          metadata_json: toJsonb(intent.metadata),
        })),
      )
      .returning("id")
      .execute();

    return rows.map((row) => row.id);
  }

  /**
   * Leases a bounded batch of unclaimed or lapsed entries, and commits the
   * lease before anything is published.
   *
   * Whether each entry's workspace still exists is decided here, with the row.
   * An entry deliberately outlives its workspace's deletion — it is evidence of
   * what happened, and a cascade would erase exactly the entries describing the
   * last thing done to a workspace being torn down — so a claim has to say
   * which entries can still be attributed to a workspace. One that cannot
   * travels with a null `workspaceId` and its former workspace as an
   * identifier, which is the only form the audit spine can publish it in.
   */
  async claim(input: { limit: number; leaseSeconds: number }): Promise<AuditOutboxClaim> {
    const claimToken = randomUUID();
    if (input.limit <= 0) return { claimToken, entries: [] };

    const entries = await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom("audit_outbox")
        .select((eb) => [
          "id",
          "account_id",
          "workspace_id",
          "event_type",
          "event_status",
          "metadata_json",
          "attempt_count",
          eb
            .exists(
              eb
                .selectFrom("workspaces")
                .select("workspaces.id")
                .whereRef("workspaces.id", "=", "audit_outbox.workspace_id"),
            )
            .as("workspace_present"),
        ])
        .where((eb) =>
          eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<=", clockTimestamp())]),
        )
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(input.limit)
        .forUpdate()
        .skipLocked()
        .execute();

      if (rows.length === 0) return [];

      const claimedUntil = await trx
        .selectNoFrom(clockTimestamp().as("at"))
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("audit_outbox")
        .set({
          claim_token: claimToken,
          claimed_until: new Date(new Date(claimedUntil.at).getTime() + input.leaseSeconds * 1000),
          attempt_count: (eb) => eb("attempt_count", "+", 1),
        })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .execute();

      return (rows as AuditOutboxClaimRow[]).map((row): ClaimedAuditOutboxEntry => {
        // A null `workspace_id` means the row never named a workspace — a host
        // or release-level event — which is not the same thing as a workspace
        // that existed and is now gone. Only a non-null id that failed the
        // existence check counts as deleted.
        const deleted = row.workspace_id !== null && !row.workspace_present;
        return {
          eventId: row.id,
          accountId: row.account_id,
          workspaceId: deleted ? null : row.workspace_id,
          deletedWorkspaceId: deleted ? row.workspace_id : null,
          eventType: row.event_type,
          eventStatus: row.event_status as ClaimedAuditOutboxEntry["eventStatus"],
          metadata: (row.metadata_json ?? {}) as Record<string, unknown>,
          attemptCount: row.attempt_count + 1,
        };
      });
    });

    return { claimToken, entries };
  }

  /**
   * Removes the entries this claim published. The token is part of the
   * predicate, so a dispatcher whose lease expired and was taken over by
   * another worker cannot acknowledge work the other worker now owns.
   */
  async acknowledge(input: { claimToken: string; eventIds: readonly string[] }): Promise<number> {
    if (input.eventIds.length === 0) return 0;

    const removed = await this.db
      .deleteFrom("audit_outbox")
      .where("claim_token", "=", input.claimToken)
      .where("id", "in", [...input.eventIds])
      .executeTakeFirst();

    return Number(removed.numDeletedRows ?? 0);
  }
}
