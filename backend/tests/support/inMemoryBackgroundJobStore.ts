import { randomUUID } from "node:crypto";

import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobEnqueueReceipt,
  BackgroundJobRequest,
  BackgroundJobStore,
  BackgroundJobWriter,
} from "../../src/shared/background-jobs/index.js";

export interface InMemoryBackgroundJobRow {
  id: string;
  kind: string;
  payload: unknown;
  idempotencyKey: string | null;
  status: "pending" | "running" | "dead";
  attempts: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  deadAt: Date | null;
}

/**
 * The `background_jobs` semantics on a controllable clock, for runtime tests: live-key
 * idempotency, due and lease-expired claims, attempt fencing, delete on completion. The Postgres
 * store is held to the same behaviour by its integration test.
 */
export class InMemoryBackgroundJobStore implements BackgroundJobStore, BackgroundJobWriter {
  readonly rows = new Map<string, InMemoryBackgroundJobRow>();

  constructor(private readonly clock: { now(): Date }) {}

  async insert(request: BackgroundJobRequest): Promise<BackgroundJobEnqueueReceipt> {
    if (request.idempotencyKey !== undefined) {
      const live = [...this.rows.values()].find((row) =>
        row.kind === request.kind && row.idempotencyKey === request.idempotencyKey && row.status !== "dead");
      if (live) {
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
    due.leaseExpiresAt = new Date(now + leases.get(due.kind)! * 1_000);
    return {
      id: due.id,
      kind: due.kind,
      payload: structuredClone(due.payload),
      attempt: due.attempts,
      availableAt: due.availableAt,
    };
  }

  async complete(claim: BackgroundJobClaim): Promise<boolean> {
    const row = this.current(claim);
    if (!row) return false;
    this.rows.delete(row.id);
    return true;
  }

  async retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null> {
    const row = this.current(claim);
    if (!row) return null;
    row.status = "pending";
    row.leaseExpiresAt = null;
    row.lastError = input.error;
    row.availableAt = new Date(this.clock.now().getTime() + input.delaySeconds * 1_000);
    return row.availableAt;
  }

  async deadLetter(claim: BackgroundJobClaim, input: { error: string }): Promise<boolean> {
    const row = this.current(claim);
    if (!row) return false;
    row.status = "dead";
    row.leaseExpiresAt = null;
    row.lastError = input.error;
    row.deadAt = this.clock.now();
    return true;
  }

  private current(claim: BackgroundJobClaim): InMemoryBackgroundJobRow | null {
    const row = this.rows.get(claim.id);
    return row && row.status === "running" && row.attempts === claim.attempt ? row : null;
  }
}
