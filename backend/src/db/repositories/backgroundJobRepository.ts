import { randomUUID } from "node:crypto";

import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobCompletion,
  BackgroundJobEnqueueReceipt,
  BackgroundJobRequest,
  BackgroundJobSkipped,
  BackgroundJobStore,
  BackgroundJobWriter,
} from "../../shared/background-jobs/index.js";
import { currentTimestamp, nowPlusSeconds, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const claimColumns = ["id", "kind", "payload", "idempotency_key", "attempts", "claim_token", "available_at"] as const;

interface ClaimRow {
  id: string;
  kind: string;
  payload: unknown;
  idempotency_key: string | null;
  attempts: number;
  claim_token: string | null;
  available_at: Date;
}

const mapClaim = (row: ClaimRow): BackgroundJobClaim => ({
  id: row.id,
  kind: row.kind,
  payload: row.payload,
  attempt: row.attempts,
  idempotencyKey: row.idempotency_key,
  token: row.claim_token!,
  availableAt: new Date(row.available_at),
});

/** The columns a run holds while running, cleared whenever the job stops running. */
const released = {
  lease_expires_at: null,
  claim_token: null,
  rerun_requested: false,
} as const;

/**
 * The generic `background_jobs` store: written by producers (alone or inside their own
 * transaction), claimed by the runtime with `FOR UPDATE SKIP LOCKED` and a lease, deleted on
 * completion. Every write back from a run is fenced on the claim's token and `running` status, so a
 * worker whose lease was taken over cannot renew, complete, retry, or dead-letter the newer claim.
 */
export class BackgroundJobRepository implements BackgroundJobStore, BackgroundJobWriter {
  constructor(private readonly db: Db) {}

  /**
   * A duplicate of a live job is folded into it. For a level-triggered kind the conflict is an
   * `ON CONFLICT DO UPDATE`, which locks the live row until the producer's transaction ends: a
   * running job is marked for a rerun its completion waits to see, and a waiting job cannot be
   * claimed before the producer's change is visible.
   */
  async insert(request: BackgroundJobRequest, executor: Db = this.db): Promise<BackgroundJobEnqueueReceipt> {
    const insert = executor
      .insertInto("background_jobs")
      .values({
        kind: request.kind,
        payload: toJsonb(request.payload),
        idempotency_key: request.idempotencyKey ?? null,
        ...(request.runAfter ? { available_at: request.runAfter } : {}),
      });
    const written = request.onDuplicateKey === "rerun"
      ? await insert
        .onConflict((conflict) =>
          conflict
            .columns(["kind", "idempotency_key"])
            .where("idempotency_key", "is not", null)
            .where("dead_at", "is", null)
            .doUpdateSet({ rerun_requested: true, updated_at: currentTimestamp() })
            .where("background_jobs.status", "=", "running"))
        .returning(["id", "status"])
        .executeTakeFirst()
      : await insert
        .onConflict((conflict) =>
          conflict
            .columns(["kind", "idempotency_key"])
            .where("idempotency_key", "is not", null)
            .where("dead_at", "is", null)
            .doNothing())
        .returning(["id", "status"])
        .executeTakeFirst();
    // A row comes back running only when the conflict marked a running job for a rerun.
    return written && written.status === "pending" ? { inserted: true, jobId: written.id } : { inserted: false };
  }

  async claimNext(input: { kinds: readonly BackgroundJobClaimableKind[]; asOf: Date }): Promise<BackgroundJobClaim | null> {
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
            eb.and([eb("status", "=", "pending"), eb("available_at", "<=", input.asOf)]),
            eb.and([eb("status", "=", "running"), eb("lease_expires_at", "<", input.asOf)]),
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
          claim_token: randomUUID(),
          // A rerun requested of an earlier run whose lease lapsed is covered by this run.
          rerun_requested: false,
          updated_at: currentTimestamp(),
        }))
        .where("id", "=", due.id)
        .returning(claimColumns)
        .executeTakeFirstOrThrow();
      return mapClaim(claimed);
    });
  }

  async renewLease(claim: BackgroundJobClaim, input: { leaseSeconds: number }): Promise<boolean> {
    const result = await this.db
      .updateTable("background_jobs")
      .set({ lease_expires_at: nowPlusSeconds(input.leaseSeconds), updated_at: currentTimestamp() })
      .where("id", "=", claim.id)
      .where("claim_token", "=", claim.token)
      .where("status", "=", "running")
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Locks the row first, so a producer still holding it (a rerun request in flight) is waited for
   * and its outcome decides: a committed rerun request returns the job to waiting, due now, with a
   * fresh attempt budget; otherwise the job is deleted.
   */
  /** No distinct "skipped" state here: a handler-returned skip completes exactly like success does. */
  async complete(claim: BackgroundJobClaim, _outcome?: BackgroundJobSkipped): Promise<BackgroundJobCompletion> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("background_jobs")
        .select("rerun_requested")
        .where("id", "=", claim.id)
        .where("claim_token", "=", claim.token)
        .where("status", "=", "running")
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        return "superseded";
      }
      if (current.rerun_requested) {
        await trx
          .updateTable("background_jobs")
          .set({
            ...released,
            status: "pending",
            attempts: 0,
            available_at: currentTimestamp(),
            last_error: null,
            updated_at: currentTimestamp(),
          })
          .where("id", "=", claim.id)
          .execute();
        return "requeued";
      }
      await trx.deleteFrom("background_jobs").where("id", "=", claim.id).execute();
      return "deleted";
    });
  }

  /**
   * A rerun requested during this run is covered by the retry, which reads state when it runs.
   * `onRetried` runs in the same transaction once the reschedule actually lands, mirroring
   * `deadLetter`'s `onParked`: a hook that throws rolls back the reschedule along with it.
   */
  async retry(
    claim: BackgroundJobClaim,
    input: { error: string; delaySeconds: number },
    onRetried?: (transaction: Db) => Promise<void>,
  ): Promise<Date | null> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("background_jobs")
        .set({
          ...released,
          status: "pending",
          available_at: nowPlusSeconds(input.delaySeconds),
          last_error: input.error,
          updated_at: currentTimestamp(),
        })
        .where("id", "=", claim.id)
        .where("claim_token", "=", claim.token)
        .where("status", "=", "running")
        .returning("available_at")
        .executeTakeFirst();
      if (!row) {
        return null;
      }
      await onRetried?.(trx);
      return new Date(row.available_at);
    });
  }

  /**
   * Parks the job and drops its payload in one fenced write, then runs `onParked` in the same
   * transaction, so a dead-letter hook's writes commit with the park or not at all.
   */
  async deadLetter(
    claim: BackgroundJobClaim,
    input: { error: string },
    onParked?: (transaction: Db) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("background_jobs")
        .set({
          ...released,
          status: "dead",
          payload: null,
          last_error: input.error,
          dead_at: currentTimestamp(),
          updated_at: currentTimestamp(),
        })
        .where("id", "=", claim.id)
        .where("claim_token", "=", claim.token)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      await onParked?.(trx);
      return true;
    });
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
