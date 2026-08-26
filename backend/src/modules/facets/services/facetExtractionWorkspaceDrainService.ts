import type { FacetExtractionDrainDispatcher, FacetExtractionJobStore } from "../contracts.js";

/**
 * Coordinates the durable facet queue with request-driven workers. It only decides
 * whether work remains and asks the transport for another bounded slice; job
 * claiming, retries, and extraction remain owned by `FacetExtractionWorker`.
 */
export class FacetExtractionWorkspaceDrainService {
  constructor(
    private readonly jobs: Pick<FacetExtractionJobStore, "nextWorkspaceScheduledAt" | "hasPendingWorkspaceWork">,
    private readonly dispatcher: FacetExtractionDrainDispatcher,
  ) {}

  async requestWorkspaceDrain(input: { workspaceId: string; analysisStart: Date; analysisEnd: Date }): Promise<boolean> {
    const window = { start: input.analysisStart, end: input.analysisEnd };
    const nextScheduledAt = await this.jobs.nextWorkspaceScheduledAt(input.workspaceId, window);
    if (!nextScheduledAt) return false;
    await this.dispatcher.requestWorkspaceDrain({ ...input, scheduleAt: nextScheduledAt });
    return true;
  }

  async hasPendingWorkspaceWork(input: { workspaceId: string; analysisStart: Date; analysisEnd: Date }): Promise<boolean> {
    return this.jobs.hasPendingWorkspaceWork(input.workspaceId, { start: input.analysisStart, end: input.analysisEnd });
  }
}
