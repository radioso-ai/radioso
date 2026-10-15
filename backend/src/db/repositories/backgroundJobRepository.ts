import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobEnqueueReceipt,
  BackgroundJobRequest,
  BackgroundJobStore,
  BackgroundJobWriter,
} from "../../shared/background-jobs/index.js";
import { currentTimestamp, nowPlusSeconds, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const claimColumns = ["id", "kind", "payload", "attempts", "available_at"] as const;

interface ClaimRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  available_at: Date;
}

const mapClaim = (row: ClaimRow): BackgroundJobClaim => ({
  id: row.id,
  kind: row.kind,
  payload: row.payload,
  attempt: row.attempts,
  availableAt: new Date(row.available_at),
});

/**
 * The generic `background_jobs` store: written by producers (alone or inside their own
 * transaction), claimed by the runtime with `FOR UPDATE SKIP LOCKED` and a lease, deleted on
 * completion. Every write back from a run is fenced on the claim's attempt and `running` status, so
 * a worker whose lease expired cannot complete, retry, or dead-letter a newer claim.
 */
export class BackgroundJobRepository implements BackgroundJobStore, BackgroundJobWriter {
  constructor(private readonly db: Db) {}

  async insert(request: BackgroundJobRequest, executor: Db = this.db): Promise<BackgroundJobEnqueueReceipt> {
    const inserted = await executor
      .insertInto("background_jobs")
      .values({
        kind: request.kind,
        payload: toJsonb(request.payload),
        idempotency_key: request.idempotencyKey ?? null,
        ...(request.runAfter ? { available_at: request.runAfter } : {}),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["kind", "idempotency_key"])
          .where("idempotency_key", "is not", null)
          .where("dead_at", "is", null)
          .doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted ? { inserted: true, jobId: inserted.id } : { inserted: false };
  }

  async claimNext(input: { kinds: readonly BackgroundJobClaimableKind[] }): Promise<BackgroundJobClaim | null> {
    if (input.kinds.length === 0) {
      return null;
    }
    return this.db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom("background_jobs")
        .select(["id", "kind"])
        .where("kind", "in", input.kinds.map((entry) => entry.kind))
        .where((eb) =>
          eb.or([
            eb.and([eb("status", "=", "pending"), eb("available_at", "<=", currentTimestamp())]),
            eb.and([eb("status", "=", "running"), eb("lease_expires_at", "<", currentTimestamp())]),
          ]))
        .orderBy("available_at", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!due) {
        return null;
      }
      const leaseSeconds = input.kinds.find((entry) => entry.kind === due.kind)!.leaseSeconds;
      const claimed = await trx
        .updateTable("background_jobs")
        .set((eb) => ({
          status: "running",
          attempts: eb("attempts", "+", 1),
          lease_expires_at: nowPlusSeconds(leaseSeconds),
          updated_at: currentTimestamp(),
        }))
        .where("id", "=", due.id)
        .returning(claimColumns)
        .executeTakeFirstOrThrow();
      return mapClaim(claimed);
    });
  }

  async complete(claim: BackgroundJobClaim): Promise<boolean> {
    const result = await this.db
      .deleteFrom("background_jobs")
      .where("id", "=", claim.id)
      .where("attempts", "=", claim.attempt)
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null> {
    const row = await this.db
      .updateTable("background_jobs")
      .set({
        status: "pending",
        available_at: nowPlusSeconds(input.delaySeconds),
        lease_expires_at: null,
        last_error: input.error,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", claim.id)
      .where("attempts", "=", claim.attempt)
      .where("status", "=", "running")
      .returning("available_at")
      .executeTakeFirst();
    return row ? new Date(row.available_at) : null;
  }

  async deadLetter(claim: BackgroundJobClaim, input: { error: string }): Promise<boolean> {
    const result = await this.db
      .updateTable("background_jobs")
      .set({
        status: "dead",
        lease_expires_at: null,
        last_error: input.error,
        dead_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", claim.id)
      .where("attempts", "=", claim.attempt)
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** The retention sweep's port: removes at most `limit` dead-lettered jobs parked before `cutoff`, oldest first. */
  async deleteBefore(input: { cutoff: Date; limit: number }): Promise<number> {
    const result = await this.db
      .deleteFrom("background_jobs")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("background_jobs")
          .select("id")
          .where("status", "=", "dead")
          .where("dead_at", "<", input.cutoff)
          .orderBy("dead_at")
          .limit(input.limit))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
