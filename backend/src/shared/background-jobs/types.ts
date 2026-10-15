import type { z } from "zod";

import type { Db } from "../infra/kysely/types.js";

/** How the runtime runs one kind: its lease, its retry budget, and the first retry delay. */
export interface BackgroundJobPolicy {
  /** Runs, including the first, before a failing job is dead-lettered. */
  readonly maxAttempts: number;
  /** How long a claim holds the job before another worker may take it over. */
  readonly leaseSeconds: number;
  /** The wait before the first retry; it doubles with each failed run, up to a fixed ceiling. */
  readonly retryBaseDelaySeconds: number;
}

/**
 * A job kind: the stable name rows are stored under, the schema every payload is checked against
 * on enqueue and again on claim, and the policy the runtime runs it with. The owning module
 * defines it once with `defineBackgroundJob` and builds requests and handlers from it.
 */
export interface BackgroundJobKind<TPayload> {
  readonly kind: string;
  readonly payload: z.ZodType<TPayload>;
  readonly policy: BackgroundJobPolicy;
}

/** A validated job, ready to be written. Built by `backgroundJobRequest`, never by hand. */
export interface BackgroundJobRequest {
  readonly kind: string;
  readonly payload: unknown;
  /**
   * Coalesces enqueues: while a job of this kind and key waits or runs, another enqueue with the
   * same key adds nothing. Completed jobs are deleted, so the same key enqueues again afterwards.
   */
  readonly idempotencyKey?: string;
  /** Runs no earlier than this. */
  readonly runAfter?: Date;
}

export type BackgroundJobEnqueueReceipt =
  | { readonly inserted: true; readonly jobId: string }
  | { readonly inserted: false };

/** What a handler learns about the run it is in, for its own correlation and idempotency. */
export interface BackgroundJobContext {
  readonly jobId: string;
  /** 1 on the first run. */
  readonly attempt: number;
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
  /** Writes the job, then wakes a worker when the write added a job. The wake is best-effort. */
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

/** One claimed run of a job. `attempt` fences every write back from the run. */
export interface BackgroundJobClaim {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempt: number;
  /** When the job became due, for queue-wait latency. */
  readonly availableAt: Date;
}

/** A kind the runtime can run, with the lease a claim of it takes. */
export interface BackgroundJobClaimableKind {
  readonly kind: string;
  readonly leaseSeconds: number;
}

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
  /** Removes a finished job. False when the claim was superseded by a newer one. */
  complete(claim: BackgroundJobClaim): Promise<boolean>;
  /** Returns the job to waiting, due after `delaySeconds`. Resolves the new due time, or null when superseded. */
  retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null>;
  /** Parks the job for inspection with its last error. False when superseded. */
  deadLetter(claim: BackgroundJobClaim, input: { error: string }): Promise<boolean>;
}

/** How a worker learns there is work: a Cloud Task, or nothing at all where a poll loop runs. */
export interface BackgroundJobWakePort {
  requestDrain(input?: { notBefore?: Date }): Promise<void>;
}
