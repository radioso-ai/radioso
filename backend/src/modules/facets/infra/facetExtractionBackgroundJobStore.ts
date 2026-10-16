import { z } from "zod";

import {
  defineBackgroundJob,
  type BackgroundJobClaim,
  type BackgroundJobClaimableKind,
  type BackgroundJobCompletion,
  type BackgroundJobStore,
} from "../../../shared/background-jobs/index.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type { FacetExtractionJobClaim, FacetExtractionJobStore } from "../contracts.js";
import { emitFacetExtractionTelemetry } from "../services/facetExtractionTelemetry.js";

/**
 * The generic per-message path: claim one due job, run its extractor, mark it. Audience Pulse's
 * workspace-scoped batch drain (`FacetExtractionWorkspaceDrainWorker`) is a different, bespoke
 * path over the same table — see that class's doc comment for why it cannot run through this
 * kind instead.
 */
const FACET_EXTRACTION_JOB_KIND = "facets.extraction";

const facetExtractionJobPayloadSchema = z.object({
  messageId: z.string(),
  workspaceId: z.string(),
});

type FacetExtractionJobPayload = z.infer<typeof facetExtractionJobPayloadSchema>;

/**
 * `onDuplicateKey` is declared but never exercised: enqueue stays on `FacetExtractionJobStore`,
 * fenced by the table's own `message_id` unique constraint, not on this kind's queue port.
 */
export const FACET_EXTRACTION_JOB = defineBackgroundJob({
  kind: FACET_EXTRACTION_JOB_KIND,
  payload: facetExtractionJobPayloadSchema,
  onDuplicateKey: "ignore",
  maxAttempts: 3,
  // The pre-existing worker claimed under a fixed 300s lease with no deadline at all. The port
  // requires a deadline shorter than the lease (and at most 240s); 240s keeps that budget as
  // close to the original as the port allows, which is a deliberate, bounded-latency addition
  // over the old unbounded claim (see the PR description).
  leaseSeconds: 300,
  timeoutSeconds: 240,
  // The old worker's own backoff was a fixed [1s, 5s, 15s] schedule, not a doubling one; the port
  // always doubles from `retryBaseDelaySeconds`. 1s keeps the first retry identical and the
  // second close (2s vs 5s) for this low-stakes, no-one-waits batch path (see the PR description).
  retryBaseDelaySeconds: 1,
});

type FacetExtractionPendingOutcome = { status: "extracted" } | { status: "skipped"; reason: string };

/**
 * Runs the generic claim/lease/complete/retry/dead-letter contract over the existing
 * `facet_extraction_jobs` table instead of `background_jobs`: the table stays the system of
 * record (coverage reads, Audience Pulse's workspace-scoped drain, and `restartTerminal`
 * backfills all read it directly), so completed, failed, and skipped rows are never deleted.
 *
 * The claim's fencing token is the row's own `claimed_at`, round-tripped as an ISO string: every
 * write below decodes it back into the `{id, attemptCount, claimedAt}` shape the pre-existing,
 * already-fenced `markCompleted` / `markSkipped` / `markFailed` methods take, so this adapter
 * adds no new column and no new fencing mechanism.
 *
 * The generic `run(): Promise<void>` has no channel for what a *successful* run did, only that it
 * did not throw — but a facet job's success has two shapes (extracted, or skipped with a reason)
 * that only the registered handler, not this store, can tell apart. `recordOutcome` is that
 * channel: the handler calls it before resolving, and `complete()` reads and clears it. See the
 * PR's "pattern for next queue" section for this as a port gap.
 */
export class FacetExtractionBackgroundJobStore implements BackgroundJobStore {
  private readonly pendingOutcomes = new Map<string, FacetExtractionPendingOutcome>();

  constructor(
    private readonly jobs: FacetExtractionJobStore,
    private readonly maxAttempts: number,
    private readonly telemetryService?: Pick<TelemetryService, "emit">,
  ) {}

  recordOutcome(jobId: string, outcome: FacetExtractionPendingOutcome): void {
    this.pendingOutcomes.set(jobId, outcome);
  }

  async claimNext(input: { kinds: readonly BackgroundJobClaimableKind[] }): Promise<BackgroundJobClaim | null> {
    const lease = input.kinds[0];
    if (!lease) {
      return null;
    }
    const now = new Date();
    // Mirrors the pre-existing worker: a separate sweep releases claims stale past this kind's
    // lease before claiming, rather than reclaiming a stale row within the same claim query.
    await this.jobs.releaseExpiredClaims({
      claimedAtOrBefore: new Date(now.getTime() - lease.leaseSeconds * 1_000),
      maxAttempts: this.maxAttempts,
    });
    const [job] = await this.jobs.claimBatch(1, now);
    if (!job || job.claimedAt === null) {
      return null;
    }
    return {
      id: job.id,
      kind: lease.kind,
      payload: { messageId: job.messageId, workspaceId: job.workspaceId } satisfies FacetExtractionJobPayload,
      attempt: job.attemptCount,
      idempotencyKey: job.messageId,
      token: job.claimedAt.toISOString(),
      availableAt: job.scheduledAt,
    };
  }

  /**
   * This table has no heartbeat: a claim is good for its fixed lease and nothing renews it, same
   * as the pre-existing worker. Nothing else can take the row before `claimNext`'s own stale-claim
   * sweep passes the same `leaseSeconds`, so reporting the lease as still held is always correct.
   */
  async renewLease(): Promise<boolean> {
    return true;
  }

  async complete(claim: BackgroundJobClaim): Promise<BackgroundJobCompletion> {
    const outcome = this.pendingOutcomes.get(claim.id);
    this.pendingOutcomes.delete(claim.id);
    if (!outcome) {
      throw new Error(`Facet extraction job ${claim.id} resolved without recording its outcome`);
    }
    const identity = this.identityOf(claim);
    const marked = outcome.status === "extracted"
      ? await this.jobs.markCompleted(identity)
      : await this.jobs.markSkipped(identity, outcome.reason);
    return marked ? "deleted" : "superseded";
  }

  async retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null> {
    const availableAt = new Date(Date.now() + input.delaySeconds * 1_000);
    const marked = await this.jobs.markFailed(this.identityOf(claim), input.error, availableAt);
    if (marked) {
      await this.emitFailure(claim, { outcome: "retry_scheduled", reason: input.error });
    }
    return marked ? availableAt : null;
  }

  async deadLetter(claim: BackgroundJobClaim, input: { error: string }): Promise<boolean> {
    const marked = await this.jobs.markFailed(this.identityOf(claim), input.error, null);
    if (marked) {
      await this.emitFailure(claim, { outcome: "failed", reason: input.error });
    }
    return marked;
  }

  private identityOf(claim: BackgroundJobClaim): FacetExtractionJobClaim {
    return { id: claim.id, attemptCount: claim.attempt, claimedAt: new Date(claim.token) };
  }

  private async emitFailure(
    claim: BackgroundJobClaim,
    input: { outcome: "retry_scheduled" | "failed"; reason: string },
  ): Promise<void> {
    const payload = facetExtractionJobPayloadSchema.parse(claim.payload);
    await emitFacetExtractionTelemetry(this.telemetryService, "facet.extraction.job_failed", {
      id: claim.id,
      workspaceId: payload.workspaceId,
      attemptCount: claim.attempt,
    }, { durationMs: 0, outcome: input.outcome, reason: input.reason });
  }
}
