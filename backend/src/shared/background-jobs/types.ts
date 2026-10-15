import type { z } from "zod";

import type { Db } from "../infra/kysely/types.js";

/**
 * What an enqueue does when a job of the same kind and idempotency key is still live.
 *
 * - `ignore` (one-shot): the duplicate is a no-op while the earlier job waits or runs. Use it when
 *   the key names one unit of work that must happen once, such as an inbound event id.
 * - `rerun` (level-triggered): a duplicate that arrives while the job is running marks it to run
 *   once more after this run, because the run may have read state the duplicate's change postdates.
 *   A duplicate of a job that has not started is folded into it. Use it when the job recomputes
 *   from current state, and only when the payload is fully determined by the key: a rerun runs the
 *   stored payload.
 *
 * Either way, once a job completes its key is free again.
 */
export type BackgroundJobDuplicateKeyMode = "ignore" | "rerun";

/** How the runtime runs one kind: its lease, its deadline, its retry budget, and its first retry delay. */
export interface BackgroundJobPolicy {
  /** Runs, including the first, before a failing job is dead-lettered. */
  readonly maxAttempts: number;
  /**
   * How long a claim holds the job without a heartbeat. The runtime renews it every third of this
   * while the handler runs; a worker that stops renewing loses the job to the next drain.
   */
  readonly leaseSeconds: number;
  /**
   * The handler's deadline. The runtime aborts the handler's signal and records a retryable failure
   * when it passes. Always shorter than the lease, so a run is abandoned before its lease could lapse.
   */
  readonly timeoutSeconds: number;
  /** The wait before the first retry; it doubles with each failed run, up to a fixed ceiling. */
  readonly retryBaseDelaySeconds: number;
}

/**
 * A job kind: the stable name rows are stored under, the schema every payload is checked against
 * on enqueue and again on claim, what a duplicate key does, and the policy the runtime runs it with.
 * The owning module defines it once with `defineBackgroundJob`.
 */
export interface BackgroundJobKind<TPayload> {
  readonly kind: string;
  readonly payload: z.ZodType<TPayload>;
  readonly onDuplicateKey: BackgroundJobDuplicateKeyMode;
  readonly policy: BackgroundJobPolicy;
}

/** A validated job, ready to be written. Built by `backgroundJobRequest`, never by hand. */
export interface BackgroundJobRequest {
  readonly kind: string;
  readonly payload: unknown;
  /** What a live job with the same kind and key does to this request; the kind decides it. */
  readonly onDuplicateKey: BackgroundJobDuplicateKeyMode;
  /** Names the unit of work, so a duplicate enqueue is handled by `onDuplicateKey`. */
  readonly idempotencyKey?: string;
  /** Runs no earlier than this. */
  readonly runAfter?: Date;
}

export type BackgroundJobEnqueueReceipt =
  | { readonly inserted: true; readonly jobId: string }
  | { readonly inserted: false };

/** What a handler learns about the run it is in. */
export interface BackgroundJobContext {
  readonly jobId: string;
  /** 1 on the first run. */
  readonly attempt: number;
  /**
   * Aborted when the run's deadline passes or its lease is lost to another worker. Pass it to
   * provider and database calls; the runtime stops waiting for the handler when it fires, and any
   * write the handler makes afterwards races the next run.
   */
  readonly signal: AbortSignal;
}

/** A kind's handler with its payload type erased, so handlers of every kind share one registry. */
export interface BackgroundJobHandlerRegistration {
  readonly kind: string;
  readonly policy: BackgroundJobPolicy;
  /** Checks the stored payload against the kind's schema, then runs the handler. */
  run(payload: unknown, context: BackgroundJobContext): Promise<void>;
}

/**
 * The producer port. Modules enqueue through it and never see the table or the transport.
 */
export interface BackgroundJobQueue {
  /**
   * Writes the job and resolves once it is stored. A worker is woken without the caller waiting on
   * it; a lost wake is logged and counted, and the sweep runs the job.
   */
  enqueue(request: BackgroundJobRequest): Promise<BackgroundJobEnqueueReceipt>;
  /**
   * Writes the job inside the caller's transaction, so it commits or rolls back with the caller's
   * own writes. The caller wakes a worker with {@link wake} once its transaction has committed.
   */
  enqueueInTransaction(transaction: Db, request: BackgroundJobRequest): Promise<BackgroundJobEnqueueReceipt>;
  /** Asks a worker to look for due jobs now. Best-effort: it never throws, and the sweep covers a lost wake. */
  wake(): Promise<void>;
}

/** Where jobs are written. The generic store implements it over `background_jobs`. */
export interface BackgroundJobWriter {
  insert(request: BackgroundJobRequest, executor?: Db): Promise<BackgroundJobEnqueueReceipt>;
}

/** One claimed run of a job. `token` fences every write back from the run. */
export interface BackgroundJobClaim {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  /** Runs started since the job last succeeded, counting this one. */
  readonly attempt: number;
  /** Unique to this claim: a worker whose claim was taken over can no longer write. */
  readonly token: string;
  /** When the job became due, for queue-wait latency. */
  readonly availableAt: Date;
}

/** A kind the runtime can run, with the lease a claim of it takes. */
export interface BackgroundJobClaimableKind {
  readonly kind: string;
  readonly leaseSeconds: number;
}

/**
 * What finishing a run did: the job is gone, it went back to waiting because a rerun was requested
 * while it ran, or the claim had already been taken over and nothing was written.
 */
export type BackgroundJobCompletion = "deleted" | "requeued" | "superseded";

/**
 * The store the runtime claims from. The generic implementation is the `background_jobs` table; a
 * module that keeps its own queue table can implement this port to run on the same runtime.
 */
export interface BackgroundJobStore {
  /**
   * Claims the job that has been due longest among `kinds` — a waiting job whose time has come, or
   * a running one whose lease expired — leases it for its kind's lease, and counts the attempt.
   * Concurrent claimers never take the same job.
   */
  claimNext(input: { kinds: readonly BackgroundJobClaimableKind[] }): Promise<BackgroundJobClaim | null>;
  /** Extends a live claim's lease from now. False when the claim was taken over. */
  renewLease(claim: BackgroundJobClaim, input: { leaseSeconds: number }): Promise<boolean>;
  /** Removes a finished job, or returns it to waiting when a rerun was requested while it ran. */
  complete(claim: BackgroundJobClaim): Promise<BackgroundJobCompletion>;
  /** Returns the job to waiting, due after `delaySeconds`. Resolves the new due time, or null when superseded. */
  retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null>;
  /** Parks the job for inspection with its last error. False when superseded. */
  deadLetter(claim: BackgroundJobClaim, input: { error: string }): Promise<boolean>;
}

/** How a worker learns there is work: a Cloud Task, or nothing at all where a poll loop runs. */
export interface BackgroundJobWakePort {
  requestDrain(input?: { notBefore?: Date }): Promise<void>;
}
