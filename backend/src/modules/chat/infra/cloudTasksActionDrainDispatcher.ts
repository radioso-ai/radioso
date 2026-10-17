import type { BackgroundJobWakePort } from "../../../shared/background-jobs/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { CloudTasksDrainDispatcher, type CloudTasksDrainTarget } from "../../../shared/infra/cloudTasksDrainDispatcher.js";

const ACTION_DRAIN_TASK_PATH = "/internal/tasks/actions/drain";

interface CloudTasksActionDrainDispatcherOptions extends CloudTasksDrainTarget {
  logger: AppLogger;
}

/**
 * Pushes a Cloud Task per action-emitting turn (and, same as the generic job substrate, a
 * scheduled wake for a retry's due time) to the action outbox's own `conversation_actions`
 * queue — kept separate from the shared background-jobs queue (#1509) so this queue's provider
 * rate limits only ever bound action deliveries. The task body carries no row-specific payload:
 * see {@link BackgroundJobWakePort}.
 */
export class CloudTasksActionDrainDispatcher implements BackgroundJobWakePort {
  private readonly drain: CloudTasksDrainDispatcher<never>;

  constructor(private readonly options: CloudTasksActionDrainDispatcherOptions) {
    this.drain = new CloudTasksDrainDispatcher({ ...options, taskPath: ACTION_DRAIN_TASK_PATH });
  }

  async requestDrain(input: { notBefore?: Date } = {}): Promise<void> {
    await this.drain.requestDrain(input.notBefore ? { scheduleAt: input.notBefore } : {});

    this.options.logger.info({ role: "action-drain-dispatcher" }, "Requested action outbox drain");
  }
}
