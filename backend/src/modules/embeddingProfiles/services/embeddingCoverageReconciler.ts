import type {
  DocumentProcessingJobRepositoryPort,
  EnqueuedEmbeddingProfileJob,
} from "../../../db/repositories/documentProcessingJobRepository.js";
import type {
  EmbeddingTransitionBackfillPort,
  EmbeddingTransitionWorkFence,
} from "./embeddingTransitionCoordinator.js";

type EmbeddingCoverageJobPort = Pick<
  DocumentProcessingJobRepositoryPort,
  | "ensureEmbeddingProfileJobsForTransition"
  | "cancelEmbeddingProfileJobsForTransition"
  | "reconcileEmbeddingProfileJobsForWorkspace"
  | "listQueuedEmbeddingProfileJobsForWorkspace"
>;

interface EmbeddingCoverageDispatchPort {
  dispatchMany(input: Array<{
    jobId: string;
    documentId: string;
    workspaceId: string;
    revision: number;
  }>): Promise<void>;
}

const noopDispatch: EmbeddingCoverageDispatchPort = {
  async dispatchMany() {},
};

export class EmbeddingCoverageReconciler
implements EmbeddingTransitionBackfillPort {
  constructor(
    private readonly jobs: EmbeddingCoverageJobPort,
    private readonly dispatcher: EmbeddingCoverageDispatchPort = noopDispatch,
  ) {}

  async ensureTransitionWork(input: EmbeddingTransitionWorkFence): Promise<void> {
    await this.jobs.ensureEmbeddingProfileJobsForTransition({
      workspaceId: input.workspaceId,
      targetEmbeddingSpaceId: input.targetEmbeddingSpaceId,
      generation: input.generation,
    });
    // Reconcile both bindings as part of the durable handoff. This repairs any
    // active-space gap while the targeted enqueue above guarantees pending work.
    await this.jobs.reconcileEmbeddingProfileJobsForWorkspace({
      workspaceId: input.workspaceId,
    });
    await this.dispatchQueuedProfileJobs({
      workspaceId: input.workspaceId,
      embeddingSpaceId: input.targetEmbeddingSpaceId,
      generation: input.generation,
    });
  }

  async cancelTransitionWork(input: EmbeddingTransitionWorkFence): Promise<void> {
    await this.jobs.cancelEmbeddingProfileJobsForTransition({
      workspaceId: input.workspaceId,
      targetEmbeddingSpaceId: input.targetEmbeddingSpaceId,
      generation: input.generation,
    });
  }

  // A per-document PATCH calls reconcileWorkspace on every retrieval-eligibility
  // change. Dispatching every queued embedding_profile job in the workspace here
  // would multiply Cloud Tasks by the number of callers, not by the work actually
  // created — so this wakes the worker only for the jobs this pass just inserted.
  // Recovery (hourly scheduler + poll loop) is the backstop for anything else queued.
  async reconcileWorkspace(
    workspaceId: string,
  ): Promise<{ enqueued: number; skipped: number }> {
    const { enqueuedJobs, skipped } = await this.jobs.reconcileEmbeddingProfileJobsForWorkspace({
      workspaceId,
    });
    await this.dispatchJobs(enqueuedJobs);
    return { enqueued: enqueuedJobs.length, skipped };
  }

  private async dispatchQueuedProfileJobs(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
    generation?: string;
  }): Promise<void> {
    const jobs = await this.jobs.listQueuedEmbeddingProfileJobsForWorkspace(input);
    await this.dispatchJobs(jobs);
  }

  private async dispatchJobs(jobs: EnqueuedEmbeddingProfileJob[]): Promise<void> {
    if (jobs.length === 0) {
      return;
    }
    try {
      await this.dispatcher.dispatchMany(
        jobs.map((job) => ({
          jobId: job.id,
          documentId: job.documentId,
          workspaceId: job.workspaceId,
          revision: job.documentRevision,
        })),
      );
    } catch {
      // Durable DB jobs remain the source of truth. Dispatch is a wake-up path;
      // scheduled recovery and polling can still reclaim queued work.
    }
  }
}
