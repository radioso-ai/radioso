import { CloudTasksDrainDispatcher, type CloudTasksDrainTarget } from "../../../shared/infra/cloudTasksDrainDispatcher.js";
import type { EmailChannelDrainDispatcherPort, EmailChannelDrainRequest, EmailChannelDrainStage } from "../drains.js";

const EMAIL_CHANNEL_DRAIN_TASK_PATH = "/internal/tasks/email-channel/drain";

interface EmailChannelDrainTaskBody {
  maxJobs: number;
  stage: EmailChannelDrainStage;
}

/**
 * Pushes email-channel drains through the shared Cloud Tasks dispatcher, at once or scheduled for
 * the time work falls due (research B7). The task names a stage and a batch size, never a row.
 */
export class CloudTasksEmailChannelDrainDispatcher implements EmailChannelDrainDispatcherPort {
  private readonly drain: CloudTasksDrainDispatcher<EmailChannelDrainTaskBody>;

  constructor(target: CloudTasksDrainTarget) {
    this.drain = new CloudTasksDrainDispatcher({ ...target, taskPath: EMAIL_CHANNEL_DRAIN_TASK_PATH });
  }

  async requestDrain(request: EmailChannelDrainRequest): Promise<void> {
    await this.drain.requestDrain({
      body: { maxJobs: request.maxJobs, stage: request.stage },
      scheduleAt: request.scheduleAt,
    });
  }
}
