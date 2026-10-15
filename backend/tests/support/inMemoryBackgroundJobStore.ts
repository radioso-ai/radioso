import { randomUUID } from "node:crypto";

import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobCompletion,
  BackgroundJobEnqueueReceipt,
  BackgroundJobRequest,
  BackgroundJobStore,
  BackgroundJobWriter,
} from "../../src/shared/background-jobs/index.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";

/** Stands in for the parking transaction a dead-letter hook receives; the fake has none. */
const IN_MEMORY_TRANSACTION = {} as Db;

export interface InMemoryBackgroundJobRow {
  id: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string | null;
  status: "pending" | "running" | "dead";
  attempts: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  claimToken: string | null;
  rerunRequested: boolean;
  lastError: string | null;
  deadAt: Date | null;
}

/**
 * The `background_jobs` semantics on a controllable clock, for runtime tests: live-key duplicates
 * folded or marked for a rerun per the request's mode, due and lease-expired claims, claim-token
 * fencing, lease renewal, delete or requeue on completion. The Postgres store is held to the same
 * behaviour by its integration test.
 */
export class InMemoryBackgroundJobStore implements BackgroundJobStore, BackgroundJobWriter {
  readonly rows = new Map<string, InMemoryBackgroundJobRow>();

  constructor(private readonly clock: { now(): Date }) {}

  async insert(request: BackgroundJobRequest): Promise<BackgroundJobEnqueueReceipt> {
    if (request.idempotencyKey !== undefined) {
      const live = [...this.rows.values()].find((row) =>
        row.kind === request.kind && row.idempotencyKey === request.idempotencyKey && row.status !== "dead");
      if (live) {
        if (request.onDuplicateKey === "rerun" && live.status === "running") {
          live.rerunRequested = true;
        }
        return { inserted: false };
      }
    }
    const id = randomUUID();
    this.rows.set(id, {
      id,
      kind: request.kind,
      payload: structuredClone(request.payload),
      idempotencyKey: request.idempotencyKey ?? null,
      status: "pending",
      attempts: 0,
      availableAt: request.runAfter ?? this.clock.now(),
      leaseExpiresAt: null,
      claimToken: null,
      rerunRequested: false,
      lastError: null,
      deadAt: null,
    });
    return { inserted: true, jobId: id };
  }

  async claimNext(input: { kinds: readonly BackgroundJobClaimableKind[] }): Promise<BackgroundJobClaim | null> {
    const now = this.clock.now().getTime();
    const leases = new Map(input.kinds.map((entry) => [entry.kind, entry.leaseSeconds]));
    const due = [...this.rows.values()]
      .filter((row) => leases.has(row.kind))
      .filter((row) =>
        (row.status === "pending" && row.availableAt.getTime() <= now) ||
        (row.status === "running" && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() < now))
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())[0];
    if (!due) {
      return null;
    }
    due.status = "running";
    due.attempts += 1;
    due.claimToken = randomUUID();
    // A rerun requested of an earlier run whose lease lapsed is covered by this run.
    due.rerunRequested = false;
    due.leaseExpiresAt = new Date(now + leases.get(due.kind)! * 1_000);
    return {
      id: due.id,
      kind: due.kind,
      payload: structuredClone(due.payload),
      attempt: due.attempts,
      idempotencyKey: due.idempotencyKey,
      token: due.claimToken,
      availableAt: due.availableAt,
    };
  }

  async renewLease(claim: BackgroundJobClaim, input: { leaseSeconds: number }): Promise<boolean> {
    const row = this.current(claim);
    if (!row) return false;
    row.leaseExpiresAt = new Date(this.clock.now().getTime() + input.leaseSeconds * 1_000);
    return true;
  }

  async complete(claim: BackgroundJobClaim): Promise<BackgroundJobCompletion> {
    const row = this.current(claim);
    if (!row) return "superseded";
    if (row.rerunRequested) {
      this.release(row);
      row.attempts = 0;
      row.lastError = null;
      row.availableAt = this.clock.now();
      return "requeued";
    }
    this.rows.delete(row.id);
    return "deleted";
  }

  async retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null> {
    const row = this.current(claim);
    if (!row) return null;
    this.release(row);
    row.lastError = input.error;
    row.availableAt = new Date(this.clock.now().getTime() + input.delaySeconds * 1_000);
    return row.availableAt;
  }

  async deadLetter(
    claim: BackgroundJobClaim,
    input: { error: string },
    onParked?: (transaction: Db) => Promise<void>,
  ): Promise<boolean> {
    const row = this.current(claim);
    if (!row) return false;
    // Runs before the row changes, so a hook that throws leaves the job as it was: a rolled-back park.
    await onParked?.(IN_MEMORY_TRANSACTION);
    this.release(row);
    row.payload = null;
    row.status = "dead";
    row.lastError = input.error;
    row.deadAt = this.clock.now();
    return true;
  }

  private release(row: InMemoryBackgroundJobRow): void {
    row.status = "pending";
    row.leaseExpiresAt = null;
    row.claimToken = null;
    row.rerunRequested = false;
  }

  private current(claim: BackgroundJobClaim): InMemoryBackgroundJobRow | null {
    const row = this.rows.get(claim.id);
    return row && row.status === "running" && row.claimToken === claim.token ? row : null;
  }
}
