import { CloudTasksClient } from "@google-cloud/tasks";

import { WORKER_TASK_AUTH_HEADER } from "./workerTaskAuth.js";

/** Where a drain task goes and how it authenticates; shared by every module's drain wrapper. */
export interface CloudTasksDrainTarget {
  client?: CloudTasksClient;
  projectId: string;
  location: string;
  queueName: string;
  workerServiceUrl: string;
  invokerServiceAccountEmail: string;
  workerTaskAuthToken: string;
}

interface CloudTasksDrainDispatcherOptions extends CloudTasksDrainTarget {
  /** Worker route the task POSTs to, e.g. `/internal/tasks/actions/drain`. */
  taskPath: string;
}

interface CloudTasksDrainRequest<Body> {
  /** JSON payload; omitted from the task when the drain is a bare trigger. */
  body?: Body;
  /** Cloud Tasks delivers no earlier than this. Ignored unless it is in the future. */
  scheduleAt?: Date;
}

interface CloudTasksDrainReceipt {
  scheduled: boolean;
}

interface CloudTasksTimestamp {
  seconds: number;
  nanos: number;
}

const normalizeUrl = (value: string): string => value.replace(/\/+$/, "");

const futureScheduleTime = (scheduleAt: Date | undefined): CloudTasksTimestamp | undefined => {
  if (!scheduleAt || scheduleAt.getTime() <= Date.now()) return undefined;
  const millis = scheduleAt.getTime();
  return { seconds: Math.floor(millis / 1_000), nanos: (millis % 1_000) * 1_000_000 };
};

/**
 * Pushes one Cloud Task that asks the worker to drain a durable queue. A task is
 * only a hint: the owning table stays authoritative, so duplicate tasks are
 * harmless. Cloud Run IAM verifies the OIDC token (service account + URL
 * audience) while the worker independently verifies the worker task token.
 * Failures propagate; callers decide whether a lost hint is tolerable.
 */
export class CloudTasksDrainDispatcher<Body> {
  private readonly client: CloudTasksClient;
  private readonly parent: string;
  private readonly targetUrl: string;

  constructor(private readonly options: CloudTasksDrainDispatcherOptions) {
    this.client = options.client ?? new CloudTasksClient();
    this.parent = this.client.queuePath(options.projectId, options.location, options.queueName);
    this.targetUrl = `${normalizeUrl(options.workerServiceUrl)}${options.taskPath}`;
  }

  async requestDrain(request: CloudTasksDrainRequest<Body> = {}): Promise<CloudTasksDrainReceipt> {
    const scheduleTime = futureScheduleTime(request.scheduleAt);
    await this.client.createTask({
      parent: this.parent,
      task: {
        ...(scheduleTime ? { scheduleTime } : {}),
        httpRequest: {
          httpMethod: "POST",
          url: this.targetUrl,
          headers: {
            "Content-Type": "application/json",
            [WORKER_TASK_AUTH_HEADER]: this.options.workerTaskAuthToken,
          },
          ...(request.body === undefined
            ? {}
            : { body: Buffer.from(JSON.stringify(request.body), "utf8").toString("base64") }),
          oidcToken: {
            serviceAccountEmail: this.options.invokerServiceAccountEmail,
            audience: this.targetUrl,
          },
        },
      },
    });
    return { scheduled: scheduleTime !== undefined };
  }
}
