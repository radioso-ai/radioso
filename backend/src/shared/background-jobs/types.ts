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
  /**
   * The wait before the first retry, doubling with each further failed attempt up to a fixed
   * ceiling — the default schedule, right for a provider call whose transient failures cluster.
   * Unused once {@link retryDelaysSeconds} is set.
   */
  readonly retryBaseDelaySeconds: number;
  /**
   * An explicit retry-delay schedule in seconds, indexed by attempt (the 1st retry takes
   * `retryDelaysSeconds[0]`, the 2nd `retryDelaysSeconds[1]`, ...); the last entry repeats for
   * every attempt past the end of the list. Set this when a kind's existing retry contract is not
   * the default doubling schedule — a flat 60 s backoff is `[60]`, a three-step schedule is
   * `[1, 5, 15]`. Omit to use doubling.
   */
  readonly retryDelaysSeconds?: readonly number[];
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

/**
 * What a kind's failure hook learns about the run that failed: the error summary, and a
 * transaction scoped to that run's write-back, so hook writes commit or roll back with it.
 * Shared by {@link BackgroundJobHandlerRegistration.onAttemptFailed} (a retryable attempt) and
 * `onDeadLetter` (the terminal one) — the two moments carry the same facts.
 */
export interface BackgroundJobFailureContext {
  readonly jobId: string;
  /** The attempt that failed. */
  readonly attempt: number;
  readonly idempotencyKey: string | null;
  /** The stored error summary: the error's class and an application error code, never its message. */
  readonly error: string;
  /**
   * The underlying error that caused this failure, when there was one — `undefined` for a
   * synthetic failure (a lease that expired with no handler run to blame, or a stored payload that
   * no longer parses). Unlike `error`, the substrate itself never logs, stores, or reports this
   * value or anything derived from it: it exists only so a handler's hook can make its own bounded,
   * structural extraction (a trailing HTTP status code, say) from an error that may carry a
   * provider response, conversation text, or a secret in its message — the same trust a handler's
   * own `run` already carries for the errors it throws. A hook must never log, store, or report
   * `cause`, its message, or any text derived from it verbatim.
   */
  readonly cause: unknown;
  /**
   * The transaction that writes back this attempt's outcome (a retry's reschedule, or the park).
   * Writes made through it commit with that outcome, so they happen exactly once; a hook that
   * throws rolls them back and the outcome is written again without it.
   */
  readonly transaction: Db;
}

/** A kind's handler with its payload type erased, so handlers of every kind share one registry. */
export interface BackgroundJobHandlerRegistration {
  readonly kind: string;
  readonly policy: BackgroundJobPolicy;
  /**
   * Checks the stored payload against the kind's schema, then runs the handler. Resolves with
   * {@link BackgroundJobSkipped} when the handler ran to completion but deliberately delivered
   * nothing — the store records that distinctly from an ordinary completion.
   */
  run(payload: unknown, context: BackgroundJobContext): Promise<BackgroundJobSkipped | void>;
  /**
   * Runs once per failed attempt that the runtime is about to retry (not the terminal one —
   * see `onDeadLetter`), fenced the same way: it runs only once the retry is actually scheduled,
   * never for an attempt whose claim was already taken over. A hook that throws rolls back with
   * the reschedule, which the runtime then writes again without it — a broken hook never blocks
   * the retry.
   *
   * Does not run for an attempt lost to a crashed or stalled worker (its lease simply expires and
   * no failure is ever reported): that attempt is only visible as the gap between its `attempt`
   * number and the next one this hook, or `onDeadLetter`, actually receives. A domain store that
   * tracks attempt history for its own records should count attempts at claim time, not rely on
   * this hook running once per attempt.
   */
  onAttemptFailed?(payload: unknown, context: BackgroundJobFailureContext): Promise<void>;
  /**
   * Runs once, inside the transaction that dead-letters a job of this kind, whatever parked it.
   * Receives the parsed payload, or null when the stored payload no longer parses.
   */
  onDeadLetter?(payload: unknown, context: BackgroundJobFailureContext): Promise<void>;
}

/**
 * A handler resolves `run` with this to mean "the work is done, but nothing was delivered by
 * design" (a configured transport that deliberately didn't send) — distinct from an ordinary
 * completion. The generic `background_jobs` store may treat it the same as completion (delete);
 * a store backing a table with its own `skipped` state (#1509's action outbox) records it there.
 */
export interface BackgroundJobSkipped {
  readonly skipped: string;
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
  readonly idempotencyKey: string | null;
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
   * a running one whose lease had expired — leases it for its kind's lease, and counts the attempt.
   * Due is always decided by the store's own clock (the database's, for the generic store), never a
   * caller-supplied instant: a caller's clock can skew from the store's and hide a job that is
   * genuinely due. Concurrent claimers never take the same job.
   *
   * `excludeIds` names jobs a single `drain()` call has already claimed, so a job that same call
   * just retried (even with a delay as short as a second) is not eligible again within that call,
   * no matter how much wall-clock time the call's other claims spend before it loops back — it
   * waits for the next wake, poll tick, or sweep instead of spending its whole retry budget on itself.
   */
  claimNext(input: { kinds: readonly BackgroundJobClaimableKind[]; excludeIds?: readonly string[] }): Promise<BackgroundJobClaim | null>;
  /** Extends a live claim's lease from now. False when the claim was taken over. */
  renewLease(claim: BackgroundJobClaim, input: { leaseSeconds: number }): Promise<boolean>;
  /**
   * Removes a finished job, or returns it to waiting when a rerun was requested while it ran.
   * `outcome` carries a {@link BackgroundJobSkipped} reason when the handler resolved with one;
   * a store with no distinct "skipped" state may just complete the job as usual.
   */
  complete(claim: BackgroundJobClaim, outcome?: BackgroundJobSkipped): Promise<BackgroundJobCompletion>;
  /**
   * Returns the job to waiting, due after `delaySeconds`. Resolves the new due time, or null when
   * superseded. `onRetried` runs in the same write-back as the reschedule, once it actually lands
   * (never for a superseded claim); if it throws, the reschedule rolls back with it and the caller
   * must call `retry` again without a hook to still reschedule the job.
   */
  retry(
    claim: BackgroundJobClaim,
    input: { error: string; delaySeconds: number },
    onRetried?: (transaction: Db) => Promise<void>,
  ): Promise<Date | null>;
  /**
   * Parks the job with its last error and drops its payload, which can carry conversation content.
   * `onParked` runs in the same transaction after the row is parked; if it throws, nothing is parked
   * and the error propagates. False, without calling `onParked`, when the claim was superseded.
   */
  deadLetter(
    claim: BackgroundJobClaim,
    input: { error: string },
    onParked?: (transaction: Db) => Promise<void>,
  ): Promise<boolean>;
}

/** How a worker learns there is work: a Cloud Task, or nothing at all where a poll loop runs. */
export interface BackgroundJobWakePort {
  requestDrain(input?: { notBefore?: Date }): Promise<void>;
}
