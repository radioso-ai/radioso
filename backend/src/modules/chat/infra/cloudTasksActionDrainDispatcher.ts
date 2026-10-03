import type { AppLogger } from "../../../shared/observability/logger.js";
import { CloudTasksDrainDispatcher, type CloudTasksDrainTarget } from "../../../shared/infra/cloudTasksDrainDispatcher.js";
import type { ActionDrainDispatcherPort } from "../services/actions/actionDrainDispatcher.js";

const ACTION_DRAIN_TASK_PATH = "/internal/tasks/actions/drain";

interface CloudTasksActionDrainDispatcherOptions extends CloudTasksDrainTarget {
  logger: AppLogger;
}

/**
 * Pushes a Cloud Task per action-emitting turn through the shared drain
 * dispatcher. The task body carries no row-specific payload — see
 * {@link ActionDrainDispatcherPort}.
 */
export class CloudTasksActionDrainDispatcher implements ActionDrainDispatcherPort {
  private readonly drain: CloudTasksDrainDispatcher<never>;

  constructor(private readonly options: CloudTasksActionDrainDispatcherOptions) {
    this.drain = new CloudTasksDrainDispatcher({ ...options, taskPath: ACTION_DRAIN_TASK_PATH });
  }

  async requestDrain(): Promise<void> {
    await this.drain.requestDrain();

    this.options.logger.info({ role: "action-drain-dispatcher" }, "Requested action outbox drain");
  }
}
