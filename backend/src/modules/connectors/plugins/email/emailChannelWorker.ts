import type { EmailChannelDrainStage, EmailInboundRepository, EmailChannelSweep } from "../../../emailChannel/public.js";
import type { EmailInboundProcessor, InboundEventOutcome } from "./emailInboundProcessor.js";
import type { EmailReviewRunner } from "./emailReviewRunner.js";

const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Events one interval tick claims. */
const POLL_BATCH = 10;
const INBOUND_STAGES: ReadonlySet<EmailChannelDrainStage> = new Set(["inbound", "all"]);
const REVIEW_STAGES: ReadonlySet<EmailChannelDrainStage> = new Set(["review", "all"]);
const RECONCILE_STAGES: ReadonlySet<EmailChannelDrainStage> = new Set(["reconcile", "all"]);

/**
 * `claimed` counts inbound events; `reviewed` the thread reviews claimed (stage 2); `reconciled`
 * the send intents claimed for reconciliation.
 */
type EmailChannelDrainResult = { claimed: number; errored: number; reviewed: number; reconciled: number } & Record<InboundEventOutcome, number>;

type EmailChannelSweepRun = Awaited<ReturnType<EmailChannelSweep["run"]>> & { drained: number };

interface EmailChannelWorkerOptions {
  /** `EMAIL_CHANNEL_WORKERS_ENABLED`: off, the worker claims nothing and runs no loop. */
  enabled: boolean;
  events: Pick<EmailInboundRepository, "claimDueEvents">;
  processor: Pick<EmailInboundProcessor, "process">;
  /** Stage 2: the coalesced review of each thread whose review is due. */
  reviews: Pick<EmailReviewRunner, "runDue">;
  sweep: Pick<EmailChannelSweep, "run" | "reconcileSends">;
  logger: {
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
  leaseSeconds?: number;
  pollIntervalMs?: number;
  sweepIntervalMs?: number;
}

const emptyResult = (): EmailChannelDrainResult => ({
  claimed: 0,
  errored: 0,
  reviewed: 0,
  reconciled: 0,
  processed: 0,
  ignored: 0,
  retrying: 0,
  failed: 0,
  superseded: 0,
});

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/**
 * Drains the email channel's durable work. Three triggers reach the same `drain` (research B12):
 * the worker runtime's interval loop (local and self-hosted), a pushed Cloud Tasks drain at the
 * time work falls due, and the scheduled sweep that recovers what a lost push left behind. Claims
 * use `SKIP LOCKED` and leases, so concurrent triggers never process one event twice.
 */
export class EmailChannelWorker {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private sweeping = false;

  constructor(private readonly options: EmailChannelWorkerOptions) {}

  get running(): boolean {
    return this.pollTimer !== null;
  }

  start(): void {
    if (!this.options.enabled || this.pollTimer) {
      return;
    }
    // The intervals intentionally keep the worker event loop alive (not unref'd).
    this.pollTimer = setInterval(() => {
      void this.tick("polling", () => this.drain({ maxJobs: POLL_BATCH, stage: "all" }));
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.sweepTimer = setInterval(() => {
      void this.tick("sweeping", () => this.sweep({ maxJobs: POLL_BATCH }));
    }, this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = null;
    this.sweepTimer = null;
  }

  /**
   * For `stage`, claims up to `maxJobs` each of: sends due reconciliation, inbound events to run
   * through stage 1, and thread reviews due to run through stage 2. Inbound goes first, so a
   * review it makes due joins the same drain.
   */
  async drain(request: { maxJobs: number; stage: EmailChannelDrainStage }): Promise<EmailChannelDrainResult> {
    const result = emptyResult();
    if (!this.options.enabled) {
      return result;
    }
    if (RECONCILE_STAGES.has(request.stage)) {
      result.reconciled = await this.options.sweep.reconcileSends({ maxJobs: request.maxJobs });
    }
    if (INBOUND_STAGES.has(request.stage)) {
      await this.drainInbound(request.maxJobs, result);
    }
    if (REVIEW_STAGES.has(request.stage)) {
      result.reviewed = (await this.options.reviews.runDue({ maxJobs: request.maxJobs })).claimed;
    }
    return result;
  }

  private async drainInbound(maxJobs: number, result: EmailChannelDrainResult): Promise<void> {
    const events = await this.options.events.claimDueEvents({
      limit: maxJobs,
      leaseSeconds: this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    });
    for (const event of events) {
      result.claimed += 1;
      try {
        result[await this.options.processor.process(event)] += 1;
      } catch (error) {
        // The claim's lease runs out and a later drain or the sweep picks the event up again.
        result.errored += 1;
        this.options.logger.error({ eventId: event.id, attempt: event.attempts, errorName: errorName(error) }, "email_inbound_event_errored");
      }
    }
  }

  /** The scheduled recovery: the sweep, then a drain of whatever it and any lost push left due. */
  async sweep(request: { maxJobs: number }): Promise<EmailChannelSweepRun | null> {
    if (!this.options.enabled) {
      return null;
    }
    const swept = await this.options.sweep.run(request);
    const drained = await this.drain({ maxJobs: request.maxJobs, stage: "all" });
    return { ...swept, drained: drained.claimed };
  }

  /** One loop tick; a tick still running skips the next, and a failure waits for the next tick. */
  private async tick(loop: "polling" | "sweeping", run: () => Promise<unknown>): Promise<void> {
    if (this[loop]) return;
    this[loop] = true;
    try {
      await run();
    } catch (error) {
      this.options.logger.warn({ loop, errorName: errorName(error) }, "email_channel_worker_tick_failed");
    } finally {
      this[loop] = false;
    }
  }
}
