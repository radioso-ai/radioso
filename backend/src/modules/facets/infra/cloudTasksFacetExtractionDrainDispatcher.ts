import type { AppLogger } from "../../../shared/observability/logger.js";
import { CloudTasksDrainDispatcher, type CloudTasksDrainTarget } from "../../../shared/infra/cloudTasksDrainDispatcher.js";
import type { FacetExtractionDrainDispatcher } from "../contracts.js";

const FACET_EXTRACTION_DRAIN_TASK_PATH = "/internal/tasks/facet-extraction/drain";

interface CloudTasksFacetExtractionDrainDispatcherOptions extends CloudTasksDrainTarget {
  logger: AppLogger;
}

interface FacetExtractionDrainTaskBody {
  workspaceId: string;
  analysisStart: string;
  analysisEnd: string;
}

/**
 * A task is only a drain hint. The durable jobs table remains authoritative, so
 * duplicate Cloud Tasks and concurrent workspace requests are harmless.
 */
export class CloudTasksFacetExtractionDrainDispatcher implements FacetExtractionDrainDispatcher {
  private readonly drain: CloudTasksDrainDispatcher<FacetExtractionDrainTaskBody>;

  constructor(private readonly options: CloudTasksFacetExtractionDrainDispatcherOptions) {
    this.drain = new CloudTasksDrainDispatcher({ ...options, taskPath: FACET_EXTRACTION_DRAIN_TASK_PATH });
  }

  async requestWorkspaceDrain(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    scheduleAt?: Date;
  }): Promise<void> {
    const { scheduled } = await this.drain.requestDrain({
      body: {
        workspaceId: input.workspaceId,
        analysisStart: input.analysisStart.toISOString(),
        analysisEnd: input.analysisEnd.toISOString(),
      },
      scheduleAt: input.scheduleAt,
    });
    this.options.logger.info(
      { role: "facet-drain-dispatcher", workspaceId: input.workspaceId, scheduled },
      "Requested facet extraction drain",
    );
  }
}
