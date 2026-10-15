import { performance } from "node:perf_hooks";

import { traceOperation } from "../observability/tracing/operations.js";
import { NonRetryableBackgroundJobError } from "./jobKind.js";
import type {
  BackgroundJobClaim,
  BackgroundJobClaimableKind,
  BackgroundJobHandlerRegistration,
  BackgroundJobStore,
  BackgroundJobWakePort,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_BATCH_SIZE = 10;
/** Doubling stops here, so a long retry budget never parks a job for days. */
const MAX_RETRY_DELAY_SECONDS = 3_600;
/** `last_error` is for an operator reading a dead letter, not an archive of provider responses. */
const MAX_ERROR_CHARS = 1_000;
const WAIT_BUCKETS_MS = [100, 500, 1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000];
const RUN_BUCKETS_MS = [10, 50, 100, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000];

type RunOutcome = "completed" | "retried" | "dead_lettered" | "superseded";

interface BackgroundJobDrainResult {
  claimed: number;
  completed: number;
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

interface RuntimeErrorReporter {
  report(input: {
    errorType: string;
    error?: unknown;
    severity?: "info" | "warn" | "error" | "fatal";
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface BackgroundJobRuntimeOptions {
  store: BackgroundJobStore;
  handlers: readonly BackgroundJobHandlerRegistration[];
  /** Schedules a wake for when a retried job is due, so a push-only worker does not wait for the sweep. */
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
  retried: "retried",
  dead_lettered: "deadLettered",
  superseded: "superseded",
};

const errorType = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const describeError = (error: unknown): string => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
};

/**
 * Runs durable background jobs: claims a due job under a lease, runs the handler registered for
 * its kind, then deletes it, retries it with a doubling backoff, or dead-letters it once its
 * attempts are spent. A job whose lease expires — its worker died or stalled — is claimed again
 * by the next drain, and the stale run's write back is fenced off by the attempt count.
 *
 * Two triggers share `drain`: the poll loop `start` runs in the worker process, and the worker
 * task route a Cloud Task or the scheduled sweep calls. Handlers must be idempotent; a job can run
 * again after a crash between its side effects and its completion.
 */
export class BackgroundJobRuntime {
  private readonly handlers = new Map<string, BackgroundJobHandlerRegistration>();
  private readonly claimableKinds: readonly BackgroundJobClaimableKind[];
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
    }));
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

  /** Runs due jobs one at a time until none is due or `maxJobs` have run. Store failures propagate. */
  async drain(input: { maxJobs: number }): Promise<BackgroundJobDrainResult> {
    const result: BackgroundJobDrainResult = { claimed: 0, completed: 0, retried: 0, deadLettered: 0, superseded: 0 };
    if (this.claimableKinds.length === 0) {
      return result;
    }
    for (let index = 0; index < input.maxJobs; index += 1) {
      const claim = await this.options.store.claimNext({ kinds: this.claimableKinds });
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
          this.options.logger.error({ errorType: errorType(error) }, "Background job poll failed");
          void this.options.errorReporter
            ?.report({ errorType: "background_job.poll_failed", error, severity: "error" })
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
    const startedAt = performance.now();
    if (claim.attempt > handler.policy.maxAttempts) {
      // Every earlier attempt was claimed and never finished: the worker died or stalled past the
      // lease each time. Running it again would exceed the budget the kind declared.
      return this.deadLetter(claim, "LeaseExpired: no attempt finished within its lease", undefined, startedAt);
    }
    try {
      await traceOperation({
        name: "background_job.run",
        attributes: { "background_job.kind": claim.kind, "background_job.attempt": claim.attempt },
        run: () => handler.run(claim.payload, { jobId: claim.id, attempt: claim.attempt }),
      });
    } catch (error) {
      return this.fail(claim, handler, error, startedAt);
    }
    const completed = await this.options.store.complete(claim);
    return this.record(claim, completed ? "completed" : "superseded", startedAt);
  }

  private async fail(
    claim: BackgroundJobClaim,
    handler: BackgroundJobHandlerRegistration,
    error: unknown,
    startedAt: number,
  ): Promise<RunOutcome> {
    if (error instanceof NonRetryableBackgroundJobError || claim.attempt >= handler.policy.maxAttempts) {
      return this.deadLetter(claim, describeError(error), error, startedAt);
    }
    const delaySeconds = Math.min(
      handler.policy.retryBaseDelaySeconds * 2 ** (claim.attempt - 1),
      MAX_RETRY_DELAY_SECONDS,
    );
    const availableAt = await this.options.store.retry(claim, { error: describeError(error), delaySeconds });
    if (!availableAt) {
      return this.record(claim, "superseded", startedAt);
    }
    await this.wakeAt(availableAt);
    return this.record(claim, "retried", startedAt, errorType(error));
  }

  private async deadLetter(
    claim: BackgroundJobClaim,
    lastError: string,
    error: unknown,
    startedAt: number,
  ): Promise<RunOutcome> {
    const parked = await this.options.store.deadLetter(claim, { error: lastError });
    if (!parked) {
      return this.record(claim, "superseded", startedAt);
    }
    void this.options.errorReporter
      ?.report({
        errorType: "background_job.dead_lettered",
        ...(error === undefined ? {} : { error }),
        severity: "error",
        metadata: { kind: claim.kind, attempt: claim.attempt, jobId: claim.id },
      })
      .catch(() => undefined);
    return this.record(claim, "dead_lettered", startedAt, error === undefined ? "LeaseExpired" : errorType(error));
  }

  /** Best-effort: the sweep still finds a retry whose wake was lost. */
  private async wakeAt(notBefore: Date): Promise<void> {
    try {
      await this.options.wake?.requestDrain({ notBefore });
    } catch (error) {
      this.options.logger.warn({ errorType: errorType(error) }, "Background job retry wake failed; the sweep will run it");
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
    const durationMs = Math.round(performance.now() - startedAt);
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
    if (outcome === "completed") {
      this.options.logger.debug(fields, "Background job completed");
    } else if (outcome === "dead_lettered") {
      this.options.logger.error(fields, "Background job dead-lettered");
    } else if (outcome === "retried") {
      this.options.logger.warn(fields, "Background job failed; retry scheduled");
    } else {
      this.options.logger.warn(fields, "Background job run superseded after its lease expired");
    }
    return outcome;
  }
}
