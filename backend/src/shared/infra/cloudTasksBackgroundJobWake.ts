import type { BackgroundJobWakePort } from "../background-jobs/index.js";
import { CloudTasksDrainDispatcher, type CloudTasksDrainTarget } from "./cloudTasksDrainDispatcher.js";

const BACKGROUND_JOB_DRAIN_TASK_PATH = "/internal/tasks/background-jobs/drain";

/**
 * Wakes the worker task server through the background-job Cloud Tasks queue. The task carries no
 * job id or payload: it asks for one drain, and the drain claims whatever is due, so a duplicate
 * or racing task finds nothing left. A retry's wake is scheduled for the retry's due time.
 */
export class CloudTasksBackgroundJobWake implements BackgroundJobWakePort {
  private readonly drain: CloudTasksDrainDispatcher<never>;

  constructor(target: CloudTasksDrainTarget) {
    this.drain = new CloudTasksDrainDispatcher({ ...target, taskPath: BACKGROUND_JOB_DRAIN_TASK_PATH });
  }

  async requestDrain(input: { notBefore?: Date } = {}): Promise<void> {
    await this.drain.requestDrain(input.notBefore ? { scheduleAt: input.notBefore } : {});
  }
}
