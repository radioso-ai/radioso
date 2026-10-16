import { AppError } from "../domain/errors.js";
import { traceOperation } from "../observability/tracing/operations.js";
import { NonRetryableBackgroundJobError } from "./jobKind.js";
import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobHandlerRegistration,
  BackgroundJobPolicy,
  BackgroundJobSkipped,
  BackgroundJobStore,
  BackgroundJobWakePort,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_BATCH_SIZE = 10;
/** A run renews its lease this many times per lease, so one slow renewal never lets it lapse. */
const HEARTBEATS_PER_LEASE = 3;
/** Doubling stops here, so a long retry budget never parks a job for days. */
const MAX_RETRY_DELAY_SECONDS = 3_600;
const WAIT_BUCKETS_MS = [100, 500, 1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000];
const RUN_BUCKETS_MS = [10, 50, 100, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000];
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.]{1,64}$/;

/** The run passed its kind's deadline; the runtime stopped waiting for it. */
class BackgroundJobTimeoutError extends Error {
  constructor() {
    super("Background job handler passed its deadline");
    this.name = "BackgroundJobTimeoutError";
  }
}

/** The run's lease was taken over by another worker; nothing it does is written back. */
class BackgroundJobLeaseLostError extends Error {
  constructor() {
    super("Background job lease was taken over by another worker");
    this.name = "BackgroundJobLeaseLostError";
  }
}

type RunOutcome = "completed" | "skipped" | "requeued" | "retried" | "dead_lettered" | "superseded";

type Execution =
  | { readonly ok: true; readonly result: BackgroundJobSkipped | void }
  | { readonly ok: false; readonly error: unknown };

interface BackgroundJobDrainResult {
  claimed: number;
  completed: number;
  skipped: number;
  requeued: number;
  retried: number;
  deadLettered: number;
  superseded: number;
}

interface RuntimeLogger {
  debug(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

interface RuntimeMetrics {
  incrementCounter(name: string, options: { help: string; labels?: Record<string, string> }): void;
  observeHistogram(
    name: string,
    options: { help: string; labels?: Record<string, string>; value?: number; buckets?: number[] },
  ): void;
}

/**
 * The runtime reports by shape only: an error's message or stack can echo a provider response or
 * customer content, so the reporter never receives the error itself.
 */
interface RuntimeErrorReporter {
  report(input: {
    errorType: string;
    severity?: "info" | "warn" | "error" | "fatal";
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface BackgroundJobRuntimeOptions {
  store: BackgroundJobStore;
  handlers: readonly BackgroundJobHandlerRegistration[];
  /** Wakes a worker for a retry's due time or a requeued rerun, so a push-only worker does not wait for the sweep. */
  wake?: BackgroundJobWakePort;
  logger: RuntimeLogger;
  metrics?: RuntimeMetrics | null;
  errorReporter?: RuntimeErrorReporter;
  pollIntervalMs?: number;
  /** Jobs one poll tick may run before yielding to the next tick. */
  pollBatchSize?: number;
  now?: () => Date;
}

const outcomeCounter: Record<RunOutcome, keyof BackgroundJobDrainResult> = {
  completed: "completed",
  skipped: "skipped",
  requeued: "requeued",
  retried: "retried",
  dead_lettered: "deadLettered",
  superseded: "superseded",
};

/**
 * What a job row keeps about a failure, for an operator reading it later: the error's class, plus
 * an application error's code. Never the message or stack, which can carry provider response
 * bodies, conversation text, or credentials.
 */
const errorSummary = (error: unknown): string => {
  const name = error instanceof Error && ERROR_NAME_PATTERN.test(error.name) ? error.name : "Error";
  return error instanceof AppError && ERROR_CODE_PATTERN.test(error.code) ? `${name} [${error.code}]` : name;
};

const isBackgroundJobSkipped = (result: BackgroundJobSkipped | void): result is BackgroundJobSkipped =>
  typeof result === "object" && result !== null && "skipped" in result;

/**
 * Runs durable background jobs: claims a due job under a lease, runs the handler registered for
 * its kind, then deletes it, requeues it for a requested rerun, retries it with a doubling backoff,
 * or dead-letters it once its attempts are spent.
 *
 * While a handler runs, the runtime renews the lease three times per lease and aborts the
 * handler's signal when a renewal finds the claim taken over or when the kind's deadline passes;
 * the deadline is always shorter than the lease. Every write back is fenced on the claim's token,
 * so a worker that lost its claim writes nothing.
 *
 * Two triggers share `drain`: the poll loop `start` runs in the worker process, and the worker
 * task route a Cloud Task or the scheduled sweep calls with a time budget. Handlers must be
 * idempotent; a job can run again after a crash between its side effects and its completion.
 */
export class BackgroundJobRuntime {
  private readonly handlers = new Map<string, BackgroundJobHandlerRegistration>();
  private readonly claimableKinds: readonly (BackgroundJobClaimableKind & { timeoutMs: number })[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly options: BackgroundJobRuntimeOptions) {
    for (const handler of options.handlers) {
      if (this.handlers.has(handler.kind)) {
        throw new Error(`Background job kind "${handler.kind}" has more than one handler`);
      }
      this.handlers.set(handler.kind, handler);
    }
    this.claimableKinds = [...this.handlers.values()].map((handler) => ({
      kind: handler.kind,
      leaseSeconds: handler.policy.leaseSeconds,
      timeoutMs: handler.policy.timeoutSeconds * 1_000,
    }));
  }

  /** The kinds this runtime has a handler for, and so claims. For startup wiring checks. */
  get registeredKinds(): readonly string[] {
    return [...this.handlers.keys()];
  }

  start(): void {
    if (this.timer || this.claimableKinds.length === 0) {
      return;
    }
    // The interval keeps the worker's event loop alive on purpose (not unref'd).
    this.timer = setInterval(() => this.tick(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  /** Stops polling and waits for the tick in flight, so a shutdown never abandons a run it could finish. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.tickInFlight;
  }

  /**
   * Runs due jobs one at a time until none is due or `maxJobs` have run. With a `budgetMs`, a job is
   * claimed only while its kind's deadline still fits in what is left of the budget, counted from
   * `startedAt` (epoch ms; now when absent), so the drain ends inside the budget even if every
   * handler runs to its deadline. Store failures propagate.
   *
   * Every claim in one `drain()` call uses the same `asOf` — this call's start time, not a fresh
   * read per claim — so a job this call itself retries (with a short delay) is not eligible again
   * within the same call: it waits for the next wake, poll tick, or sweep instead of spending its
   * whole retry budget here.
   */
  async drain(input: { maxJobs: number; budgetMs?: number; startedAt?: number }): Promise<BackgroundJobDrainResult> {
    const result: BackgroundJobDrainResult = {
      claimed: 0,
      completed: 0,
      skipped: 0,
      requeued: 0,
      retried: 0,
      deadLettered: 0,
      superseded: 0,
    };
    const startedAt = input.startedAt ?? Date.now();
    const asOf = new Date(startedAt);
    for (let index = 0; index < input.maxJobs; index += 1) {
      const remainingMs = input.budgetMs === undefined ? Infinity : input.budgetMs - (Date.now() - startedAt);
      const kinds = this.claimableKinds.filter((entry) => entry.timeoutMs <= remainingMs);
      if (kinds.length === 0) {
        break;
      }
      const claim = await this.options.store.claimNext({
        kinds: kinds.map(({ kind, leaseSeconds }) => ({ kind, leaseSeconds })),
        asOf,
      });
      if (!claim) {
        break;
      }
      result.claimed += 1;
      result[outcomeCounter[await this.run(claim)]] += 1;
    }
    return result;
  }

  private tick(): void {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = this.drain({ maxJobs: this.options.pollBatchSize ?? DEFAULT_POLL_BATCH_SIZE })
      .then(
        () => undefined,
        (error: unknown) => {
          const summary = errorSummary(error);
          this.options.logger.error({ errorType: summary }, "Background job poll failed");
          void this.options.errorReporter
            ?.report({ errorType: "background_job.poll_failed", severity: "error", metadata: { errorClass: summary } })
            .catch(() => undefined);
        },
      )
      .finally(() => {
        this.tickInFlight = null;
      });
  }

  private async run(claim: BackgroundJobClaim): Promise<RunOutcome> {
    const handler = this.handlers.get(claim.kind)!;
    this.observeWait(claim);
    const startedAt = Date.now();
    if (claim.attempt > handler.policy.maxAttempts) {
      // Every earlier attempt was claimed and never finished: the worker died or stalled past the
      // lease each time. Running it again would exceed the budget the kind declared.
      return this.deadLetter(claim, handler, "BackgroundJobLeaseExpiredError", startedAt);
    }
    const execution = await this.execute(claim, handler);
    if (!execution.ok) {
      if (execution.error instanceof BackgroundJobLeaseLostError) {
        return this.record(claim, "superseded", startedAt);
      }
      return this.fail(claim, handler, execution.error, startedAt);
    }
    const skipped = isBackgroundJobSkipped(execution.result) ? execution.result : undefined;
    const completion = await this.options.store.complete(claim, skipped);
    if (completion === "requeued") {
      // A rerun was requested while this run held the job: it is due now.
      await this.wakeAt(undefined);
      return this.record(claim, "requeued", startedAt);
    }
    if (completion !== "deleted") {
      return this.record(claim, "superseded", startedAt);
    }
    return this.record(claim, skipped ? "skipped" : "completed", startedAt);
  }

  /**
   * Runs the handler under the kind's deadline while renewing the lease. Resolves when the handler
   * settles or when the run is interrupted, whichever comes first; a handler that ignores its
   * aborted signal is left behind, and anything it writes afterwards is fenced or races the retry.
   */
  private async execute(claim: BackgroundJobClaim, handler: BackgroundJobHandlerRegistration): Promise<Execution> {
    const controller = new AbortController();
    const interrupted = new Promise<Execution>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve({ ok: false, error: controller.signal.reason }), { once: true });
    });
    const deadline = setTimeout(() => controller.abort(new BackgroundJobTimeoutError()), handler.policy.timeoutSeconds * 1_000);
    const heartbeat = setInterval(
      () => void this.renewLease(claim, handler, controller),
      (handler.policy.leaseSeconds * 1_000) / HEARTBEATS_PER_LEASE,
    );
    try {
      const settled = traceOperation({
        name: "background_job.run",
        attributes: { "background_job.kind": claim.kind, "background_job.attempt": claim.attempt },
        run: () => handler.run(claim.payload, { jobId: claim.id, attempt: claim.attempt, signal: controller.signal }),
      }).then(
        (result): Execution => ({ ok: true, result }),
        (error: unknown): Execution => ({ ok: false, error }),
      );
      const execution = await Promise.race([settled, interrupted]);
      // A handler that rejected because its signal fired failed for the signal's reason.
      return !execution.ok && controller.signal.aborted ? { ok: false, error: controller.signal.reason } : execution;
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
  }

  /** A renewal that fails to reach the store is retried at the next heartbeat; one that finds the claim gone aborts the run. */
  private async renewLease(
    claim: BackgroundJobClaim,
    handler: BackgroundJobHandlerRegistration,
    controller: AbortController,
  ): Promise<void> {
    if (controller.signal.aborted) {
      return;
    }
    try {
      const renewed = await this.options.store.renewLease(claim, { leaseSeconds: handler.policy.leaseSeconds });
      if (!renewed) {
        controller.abort(new BackgroundJobLeaseLostError());
      }
    } catch (error) {
      this.options.logger.warn(
        { kind: claim.kind, jobId: claim.id, attempt: claim.attempt, errorType: errorSummary(error) },
        "Background job lease renewal failed; retrying at the next heartbeat",
      );
    }
  }

  private async fail(
    claim: BackgroundJobClaim,
    handler: BackgroundJobHandlerRegistration,
    error: unknown,
    startedAt: number,
  ): Promise<RunOutcome> {
    const summary = errorSummary(error);
    if (error instanceof NonRetryableBackgroundJobError || claim.attempt >= handler.policy.maxAttempts) {
      return this.deadLetter(claim, handler, summary, startedAt);
    }
    const delaySeconds = this.retryDelaySeconds(handler.policy, claim.attempt);
    const availableAt = await this.scheduleRetry(claim, handler, summary, delaySeconds);
    if (!availableAt) {
      return this.record(claim, "superseded", startedAt);
    }
    await this.wakeAt(availableAt);
    return this.record(claim, "retried", startedAt, summary);
  }

  /**
   * `retryDelaysSeconds[attempt - 1]`, clamped to its last entry once attempts run past it; absent
   * a schedule, the default is `retryBaseDelaySeconds` doubled per attempt, up to a fixed ceiling.
   */
  private retryDelaySeconds(policy: BackgroundJobPolicy, attempt: number): number {
    if (policy.retryDelaysSeconds && policy.retryDelaysSeconds.length > 0) {
      const index = Math.min(attempt - 1, policy.retryDelaysSeconds.length - 1);
      return policy.retryDelaysSeconds[index];
    }
    return Math.min(policy.retryBaseDelaySeconds * 2 ** (attempt - 1), MAX_RETRY_DELAY_SECONDS);
  }

  /**
   * Reschedules the retry, running the kind's per-attempt hook in the same write-back. Mirrors
   * `park()`: the store fences the reschedule on the claim token, so an attempt whose claim was
   * taken over never runs the hook. A hook that throws rolls back with the reschedule, and the
   * retry is written again without it — a broken hook must not strand a retryable job.
   */
  private async scheduleRetry(
    claim: BackgroundJobClaim,
    handler: BackgroundJobHandlerRegistration,
    summary: string,
    delaySeconds: number,
  ): Promise<Date | null> {
    if (!handler.onAttemptFailed) {
      return this.options.store.retry(claim, { error: summary, delaySeconds });
    }
    const failed: { hookError?: unknown } = {};
    try {
      return await this.options.store.retry(claim, { error: summary, delaySeconds }, async (transaction) => {
        try {
          await handler.onAttemptFailed?.(claim.payload, {
            jobId: claim.id,
            attempt: claim.attempt,
            idempotencyKey: claim.idempotencyKey,
            error: summary,
            transaction,
          });
        } catch (error) {
          failed.hookError = error;
          throw error;
        }
      });
    } catch (error) {
      if (!("hookError" in failed)) {
        throw error;
      }
      const hookError = errorSummary(failed.hookError);
      this.options.logger.warn(
        { kind: claim.kind, jobId: claim.id, attempt: claim.attempt, errorType: hookError },
        "Background job per-attempt failure hook failed; the retry is scheduled without it",
      );
      this.report("background_job.attempt_failed_hook_failed", { kind: claim.kind, attempt: claim.attempt, jobId: claim.id, hookError });
      return this.options.store.retry(claim, { error: summary, delaySeconds });
    }
  }

  private async deadLetter(
    claim: BackgroundJobClaim,
    handler: BackgroundJobHandlerRegistration,
    summary: string,
    startedAt: number,
  ): Promise<RunOutcome> {
    const parked = await this.park(claim, handler, summary);
    if (!parked) {
      return this.record(claim, "superseded", startedAt);
    }
    this.report("background_job.dead_lettered", { kind: claim.kind, attempt: claim.attempt, jobId: claim.id, lastError: summary });
    return this.record(claim, "dead_lettered", startedAt, summary);
  }

  /**
   * Parks the job, running the kind's dead-letter hook in the parking transaction. The store fences
   * the park on the claim token, so an attempt whose claim was taken over never runs the hook. A
   * hook that throws rolls back with its writes, and the job is parked without it: a broken hook
   * must not keep a failed job alive.
   */
  private async park(
    claim: BackgroundJobClaim,
    handler: BackgroundJobHandlerRegistration,
    summary: string,
  ): Promise<boolean> {
    if (!handler.onDeadLetter) {
      return this.options.store.deadLetter(claim, { error: summary });
    }
    const failed: { hookError?: unknown } = {};
    try {
      return await this.options.store.deadLetter(claim, { error: summary }, async (transaction) => {
        try {
          await handler.onDeadLetter?.(claim.payload, {
            jobId: claim.id,
            attempt: claim.attempt,
            idempotencyKey: claim.idempotencyKey,
            error: summary,
            transaction,
          });
        } catch (error) {
          failed.hookError = error;
          throw error;
        }
      });
    } catch (error) {
      if (!("hookError" in failed)) {
        throw error;
      }
      const hookError = errorSummary(failed.hookError);
      this.options.logger.warn(
        { kind: claim.kind, jobId: claim.id, attempt: claim.attempt, errorType: hookError },
        "Background job dead-letter hook failed; the job is parked without it",
      );
      this.report("background_job.dead_letter_hook_failed", { kind: claim.kind, attempt: claim.attempt, jobId: claim.id, hookError });
      return this.options.store.deadLetter(claim, { error: summary });
    }
  }

  private report(errorType: string, metadata: Record<string, unknown>): void {
    void this.options.errorReporter?.report({ errorType, severity: "error", metadata }).catch(() => undefined);
  }

  /** Best-effort: the sweep still finds a job whose wake was lost. */
  private async wakeAt(notBefore: Date | undefined): Promise<void> {
    try {
      await this.options.wake?.requestDrain(notBefore ? { notBefore } : undefined);
    } catch (error) {
      this.options.logger.warn({ errorType: errorSummary(error) }, "Background job wake failed; the sweep will run the job");
    }
  }

  private observeWait(claim: BackgroundJobClaim): void {
    const now = (this.options.now ?? (() => new Date()))();
    this.options.metrics?.observeHistogram("background_job_wait_ms", {
      help: "Time a background job waited between becoming due and being claimed.",
      labels: { kind: claim.kind },
      value: Math.max(0, now.getTime() - claim.availableAt.getTime()),
      buckets: WAIT_BUCKETS_MS,
    });
  }

  private record(claim: BackgroundJobClaim, outcome: RunOutcome, startedAt: number, failure?: string): RunOutcome {
    const durationMs = Math.max(0, Date.now() - startedAt);
    this.options.metrics?.incrementCounter("background_jobs_total", {
      help: "Background job runs by kind and outcome.",
      labels: { kind: claim.kind, outcome },
    });
    this.options.metrics?.observeHistogram("background_job_run_duration_ms", {
      help: "Background job run time by kind and outcome.",
      labels: { kind: claim.kind, outcome },
      value: durationMs,
      buckets: RUN_BUCKETS_MS,
    });
    // Ids and counts only: a payload can carry conversation content.
    const fields = {
      kind: claim.kind,
      jobId: claim.id,
      attempt: claim.attempt,
      outcome,
      durationMs,
      ...(failure ? { errorType: failure } : {}),
    };
    if (outcome === "completed" || outcome === "requeued" || outcome === "skipped") {
      this.options.logger.debug(
        fields,
        outcome === "completed"
          ? "Background job completed"
          : outcome === "skipped"
            ? "Background job completed; delivery skipped by design"
            : "Background job completed; rerun queued",
      );
    } else if (outcome === "dead_lettered") {
      this.options.logger.error(fields, "Background job dead-lettered");
    } else if (outcome === "retried") {
      this.options.logger.warn(fields, "Background job failed; retry scheduled");
    } else {
      this.options.logger.warn(fields, "Background job run superseded after its lease was taken over");
    }
    return outcome;
  }
}
