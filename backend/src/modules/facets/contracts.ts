import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";

/**
 * Per-message facet extraction contracts.
 *
 * A "facet" is the question-shaped restatement of a single visitor message, stored
 * on `message_facets` and later clustered into topics by the census run. Extraction
 * is batch analytics: no turn, request, or user-visible surface waits on it, which is
 * why the spine is a polling claim loop rather than a queue dispatcher pair.
 *
 * This module owns both ports so the dependency direction points inward: the Postgres
 * repository implements {@link FacetExtractionJobStore}, and the LLM extractor
 * implements {@link FacetExtractionPort}. The worker knows neither implementation.
 */

export type FacetExtractionJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

export interface FacetExtractionJob {
  id: string;
  messageId: string;
  workspaceId: string;
  status: FacetExtractionJobStatus;
  /** Attempts started, incremented when the row is claimed. */
  attemptCount: number;
  claimedAt: Date | null;
  scheduledAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FacetExtractionJobClaim = Pick<FacetExtractionJob, "id" | "attemptCount" | "claimedAt">;

export interface FacetExtractionEnqueueResult {
  id: string;
  /** False when a job already existed for the message (the unique message_id won). */
  created: boolean;
}

/**
 * The durable job spine the worker polls. One job per message, enforced by the
 * `message_id` unique constraint, so a replayed enqueue never duplicates work and
 * never resurrects a job that already reached a terminal status.
 */
export interface FacetExtractionJobStore {
  enqueue(input: {
    messageId: string;
    workspaceId: string;
    /**
     * Used by prompt-version backfills only. Live turn enqueue leaves existing jobs
     * untouched, while a stale-facet backfill can return terminal rows to the queue.
     */
    restartTerminal?: boolean;
  }): Promise<FacetExtractionEnqueueResult>;
  /**
   * Atomically claim up to `limit` due (`queued`, `scheduled_at <= now`) jobs, moving
   * them to `processing` and counting the attempt. Implementations must use
   * `FOR UPDATE SKIP LOCKED` so concurrent workers claim disjoint rows.
   */
  claimBatch(
    limit: number,
    now?: Date,
    workspaceId?: string,
    messageWindow?: { start: Date; end: Date },
  ): Promise<FacetExtractionJob[]>;
  /**
   * Terminal/progress updates are fenced to the claim returned by `claimBatch`.
   * Returns false when the row has since been released/reclaimed/completed by another
   * worker, so late workers cannot overwrite newer state.
   */
  markCompleted(job: FacetExtractionJobClaim): Promise<boolean>;
  markSkipped(job: FacetExtractionJobClaim, reason: string): Promise<boolean>;
  /**
   * Record a failed attempt. `nextScheduledAt` returns the job to `queued` for a later
   * attempt; `null` makes the failure terminal.
   */
  markFailed(job: FacetExtractionJobClaim, error: string, nextScheduledAt: Date | null): Promise<boolean>;
  /**
   * Return `processing` rows claimed at or before `claimedAtOrBefore` to the queue, so a
   * worker that died mid-batch cannot strand jobs. Returns the number released.
   */
  releaseExpiredClaims(input: { claimedAtOrBefore: Date; maxAttempts: number; workspaceId?: string }): Promise<number>;
  /** The next queued job for one workspace, if work remains. */
  nextWorkspaceScheduledAt(workspaceId: string, messageWindow?: { start: Date; end: Date }): Promise<Date | null>;
  hasPendingWorkspaceWork(workspaceId: string, messageWindow?: { start: Date; end: Date }): Promise<boolean>;
}

/** Requests one bounded, authenticated worker slice. Duplicate requests are safe: claims are lease fenced. */
export interface FacetExtractionDrainDispatcher {
  requestWorkspaceDrain(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    scheduleAt?: Date;
  }): Promise<void>;
}

/** Local development keeps using the worker poll loop, so no remote task is needed. */
export class NoopFacetExtractionDrainDispatcher implements FacetExtractionDrainDispatcher {
  async requestWorkspaceDrain(): Promise<void> {}
}

export type FacetExtractionOutcome =
  | { status: "extracted" }
  | { status: "skipped"; reason: string };

/**
 * Extracts and persists the facet for one message. Implemented outside this spine
 * (the LLM extractor); the worker only runs it, applies the retry policy, and records
 * the outcome.
 */
export interface FacetExtractionPort {
  extract(job: FacetExtractionJob): Promise<FacetExtractionOutcome>;
}

/**
 * Persistence for `message_facets`: the stored, PII-stripped restatement of a visitor
 * question plus its embedding. Embeddings are attached in a second step once the
 * embedding profile call completes, so a facet can exist with `embedding: null`.
 */
export interface UpsertFacetInput {
  messageId: string;
  workspaceId: string;
  facetText: string;
  promptVersion: string;
}

export interface AttachFacetEmbeddingInput {
  messageId: string;
  embedding: number[];
  embeddingProfileId: string;
}

export interface MessageFacetRecord {
  messageId: string;
  facetText: string;
  embedding: number[] | null;
  promptVersion: string;
  embeddingProfileId: string | null;
}

export interface MessageFacetRepositoryPort {
  /**
   * Insert or update the stored facet for a message. A re-extraction (prompt version
   * bump) always leaves `embedding` null, since the prior embedding was computed
   * against the old facet text and is no longer valid.
   */
  upsertFacet(input: UpsertFacetInput): Promise<void>;
  /** Sets `embedding` and `dimensions` together so the two are never inconsistent. */
  attachEmbedding(input: AttachFacetEmbeddingInput): Promise<void>;
  /** Every stored facet among `messageIds`; the census read path. */
  listForWindow(input: {
    workspaceId: string;
    messageIds: string[];
  }): Promise<MessageFacetRecord[]>;
  /**
   * Message ids among `messageIds` with no current embedded facet. When
   * `embeddingProfileId` is supplied, rows embedded in any other clustering space are
   * stale and should be queued for re-embedding.
   */
  listMessageIdsMissingCurrentFacet(input: {
    workspaceId: string;
    messageIds: string[];
    promptVersion: string;
    embeddingProfileId?: string;
  }): Promise<string[]>;
}

/**
 * Narrow read access to the source message's content. Facet extraction needs the text
 * of one message by id; the full chat `MessageRepositoryPort` is a much larger surface
 * than this module should depend on. Returns `null` when the message no longer exists.
 */
export interface FacetSourceMessagePort {
  getContentById(input: { workspaceId: string; messageId: string }): Promise<string | null>;
}

/**
 * Generic workspace-scoped structured inference seam, narrowed to what facet
 * extraction needs. Mirrors `AudiencePulseInferenceFactory`: the module declares its
 * own shape rather than importing the shared infra factory type directly, so the
 * dependency direction stays inward and composition supplies the cheap-tier
 * implementation (`createRewriteTierStructuredInferenceFactory`).
 */
export interface FacetExtractionInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string };
    modelCallContext: ModelCallUsageContext;
  }): Promise<ModelInferencePipeline>;
}
