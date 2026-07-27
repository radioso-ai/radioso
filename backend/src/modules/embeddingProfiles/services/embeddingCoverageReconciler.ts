import type { DocumentProcessingJobRepositoryPort } from "../../../db/repositories/documentProcessingJobRepository.js";
import type {
  EmbeddingTransitionBackfillPort,
  EmbeddingTransitionWorkFence,
} from "./embeddingTransitionCoordinator.js";

export type EmbeddingCoverageJobPort = Pick<
  DocumentProcessingJobRepositoryPort,
  | "ensureEmbeddingProfileJobsForTransition"
  | "cancelEmbeddingProfileJobsForTransition"
  | "reconcileEmbeddingProfileJobsForWorkspace"
  | "listQueuedEmbeddingProfileJobsForWorkspace"
>;

export interface EmbeddingCoverageDispatchPort {
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

  async reconcileWorkspace(
    workspaceId: string,
  ): Promise<{ enqueued: number; skipped: number }> {
    const outcome = await this.jobs.reconcileEmbeddingProfileJobsForWorkspace({ workspaceId });
    await this.dispatchQueuedProfileJobs({ workspaceId });
    return outcome;
  }

  private async dispatchQueuedProfileJobs(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
    generation?: string;
  }): Promise<void> {
    const jobs = await this.jobs.listQueuedEmbeddingProfileJobsForWorkspace(input);
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
