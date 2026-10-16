import { z } from "zod";

import {
  BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
  defineBackgroundJob,
  NonRetryableBackgroundJobError,
  type BackgroundJobClaim,
  type BackgroundJobClaimableKind,
  type BackgroundJobCompletion,
  type BackgroundJobSkipped,
  type BackgroundJobStore,
} from "../../../shared/background-jobs/index.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type { FacetExtractionJobClaim, FacetExtractionJobStore } from "../contracts.js";
import { emitFacetExtractionTelemetry } from "../services/facetExtractionTelemetry.js";
import {
  FACET_EXTRACTION_MAX_ATTEMPTS,
  FACET_EXTRACTION_RETRY_DELAYS_MS,
} from "../services/facetExtractionWorkspaceDrainWorker.js";

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

/** Matches `FACET_EXTRACTION_JOB_LEASE_MS`'s own default (300_000 ms). */
const DEFAULT_LEASE_SECONDS = 300;
/** The deadline sits comfortably under the lease, however the lease is configured. */
const DEADLINE_MARGIN_SECONDS = 10;

/**
 * Builds the `facets.extraction` kind for a configured lease (seconds), sharing the retry
 * schedule and attempt budget with the workspace-scoped drain path so the two never drift apart.
 * `onDuplicateKey` is declared but never exercised: enqueue stays on `FacetExtractionJobStore`,
 * fenced by the table's own `message_id` unique constraint, not on this kind's queue port.
 */
export const createFacetExtractionJobKind = (input: { leaseSeconds?: number } = {}) => {
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  return defineBackgroundJob({
    kind: FACET_EXTRACTION_JOB_KIND,
    payload: facetExtractionJobPayloadSchema,
    onDuplicateKey: "ignore",
    maxAttempts: FACET_EXTRACTION_MAX_ATTEMPTS,
    leaseSeconds,
    timeoutSeconds: Math.min(
      BACKGROUND_JOB_MAX_TIMEOUT_SECONDS,
      Math.max(1, leaseSeconds - DEADLINE_MARGIN_SECONDS),
    ),
    // The exact pre-existing schedule, in seconds, from the same constant the workspace-scoped
    // drain path still uses directly — one source of truth for both paths.
    retryDelaysSeconds: FACET_EXTRACTION_RETRY_DELAYS_MS.map((ms) => ms / 1_000),
  });
};

/** The default-configured kind, for tests and callers with no env override. */
export const FACET_EXTRACTION_JOB = createFacetExtractionJobKind();

/**
 * Runs the generic claim/lease/complete/retry/dead-letter contract over the existing
 * `facet_extraction_jobs` table instead of `background_jobs`: the table stays the system of
 * record (coverage reads, Audience Pulse's workspace-scoped drain, and `restartTerminal`
 * backfills all read it directly), so completed, failed, and skipped rows are never deleted.
 *
 * The claim's fencing token is the row's own `claimed_at`, round-tripped as an ISO string: every
 * write below decodes it back into the `{id, attemptCount, claimedAt}` shape the pre-existing,
 * already-fenced `markCompleted` / `markSkipped` / `markFailed` methods take, so this adapter
 * adds no new column and no new fencing mechanism. The same decoded `claimedAt` also gives every
 * write a real run duration for telemetry, without a second side channel.
 */
export class FacetExtractionBackgroundJobStore implements BackgroundJobStore {
  constructor(
    private readonly jobs: FacetExtractionJobStore,
    private readonly maxAttempts: number,
    private readonly telemetryService?: Pick<TelemetryService, "emit">,
  ) {}

  async claimNext(input: { kinds: readonly BackgroundJobClaimableKind[]; asOf: Date }): Promise<BackgroundJobClaim | null> {
    const lease = input.kinds[0];
    if (!lease) {
      return null;
    }
    // Mirrors the pre-existing worker: a separate sweep releases claims stale past this kind's
    // lease before claiming, rather than reclaiming a stale row within the same claim query.
    // `asOf` is fixed for the whole drain, not read fresh here, so a job this same drain already
    // retried with a short delay is not reclaimable again until the next wake, poll tick, or sweep.
    await this.jobs.releaseExpiredClaims({
      claimedAtOrBefore: new Date(input.asOf.getTime() - lease.leaseSeconds * 1_000),
      maxAttempts: this.maxAttempts,
    });
    const [job] = await this.jobs.claimBatch(1, input.asOf);
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

  async complete(claim: BackgroundJobClaim, outcome?: BackgroundJobSkipped): Promise<BackgroundJobCompletion> {
    const identity = this.identityOf(claim);
    const marked = outcome
      ? await this.jobs.markSkipped(identity, outcome.skipped)
      : await this.jobs.markCompleted(identity);
    if (!marked) {
      return "superseded";
    }
    await emitFacetExtractionTelemetry(
      this.telemetryService,
      outcome ? "facet.extraction.job_skipped" : "facet.extraction.job_completed",
      this.correlationOf(claim),
      {
        durationMs: this.durationMsSince(identity),
        outcome: outcome ? "skipped" : "completed",
        ...(outcome ? { reason: outcome.skipped } : {}),
      },
    );
    return "deleted";
  }

  async retry(claim: BackgroundJobClaim, input: { error: string; delaySeconds: number }): Promise<Date | null> {
    const identity = this.identityOf(claim);
    const availableAt = new Date(Date.now() + input.delaySeconds * 1_000);
    const marked = await this.jobs.markFailed(identity, input.error, availableAt);
    if (!marked) {
      return null;
    }
    await emitFacetExtractionTelemetry(this.telemetryService, "facet.extraction.job_failed", this.correlationOf(claim), {
      durationMs: this.durationMsSince(identity),
      outcome: "retry_scheduled",
      reason: input.error,
    });
    return availableAt;
  }

  async deadLetter(claim: BackgroundJobClaim, input: { error: string }): Promise<boolean> {
    const identity = this.identityOf(claim);
    const marked = await this.jobs.markFailed(identity, input.error, null);
    if (!marked) {
      return false;
    }
    // The only signal available here: a handler throws `NonRetryableBackgroundJobError` for a
    // permanent failure, and the generic runtime's own error summary is just the class name (no
    // `AppError` code on this class), so this exact match is the same "permanent" fact the
    // pre-existing worker's `isPermanentProviderFailure` classified directly.
    const permanent = input.error === NonRetryableBackgroundJobError.name;
    await emitFacetExtractionTelemetry(this.telemetryService, "facet.extraction.job_failed", this.correlationOf(claim), {
      durationMs: this.durationMsSince(identity),
      outcome: permanent ? "failed_permanent" : "failed",
      reason: input.error,
    });
    return true;
  }

  private identityOf(claim: BackgroundJobClaim): FacetExtractionJobClaim {
    return { id: claim.id, attemptCount: claim.attempt, claimedAt: new Date(claim.token) };
  }

  private correlationOf(claim: BackgroundJobClaim): { id: string; workspaceId: string; attemptCount: number } {
    const payload = facetExtractionJobPayloadSchema.parse(claim.payload);
    return { id: claim.id, workspaceId: payload.workspaceId, attemptCount: claim.attempt };
  }

  /** The claim token is this attempt's `claimed_at`, so this is the attempt's real wall-clock duration. */
  private durationMsSince(identity: FacetExtractionJobClaim): number {
    return Math.max(0, Date.now() - identity.claimedAt!.getTime());
  }
}
