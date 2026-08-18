import { CloudTasksClient } from "@google-cloud/tasks";

import type { AppLogger } from "../../../shared/observability/logger.js";
import { WORKER_TASK_AUTH_HEADER } from "../../../shared/infra/workerTaskAuth.js";
import type { ActionDrainDispatcherPort } from "../services/actions/actionDrainDispatcher.js";

const ACTION_DRAIN_TASK_PATH = "/internal/tasks/actions/drain";

export interface CloudTasksActionDrainDispatcherOptions {
  client?: CloudTasksClient;
  projectId: string;
  location: string;
  queueName: string;
  workerServiceUrl: string;
  invokerServiceAccountEmail: string;
  workerTaskAuthToken: string;
  logger: AppLogger;
}

const normalizeUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Pushes a Cloud Task per action-emitting turn, mirroring
 * `CloudTasksDocumentJobDispatcher` (documents module) exactly: same OIDC-token
 * shape (service account + URL audience), same queue/parent construction. The
 * task body carries no row-specific payload — see {@link ActionDrainDispatcherPort}.
 * Cloud Run IAM verifies the OIDC token while the worker service independently
 * verifies the application-level worker task token.
 */
export class CloudTasksActionDrainDispatcher implements ActionDrainDispatcherPort {
  private readonly client: CloudTasksClient;
  private readonly parent: string;
  private readonly targetUrl: string;

  constructor(private readonly options: CloudTasksActionDrainDispatcherOptions) {
    this.client = options.client ?? new CloudTasksClient();
    this.parent = this.client.queuePath(options.projectId, options.location, options.queueName);
    this.targetUrl = `${normalizeUrl(options.workerServiceUrl)}${ACTION_DRAIN_TASK_PATH}`;
  }

  async requestDrain(): Promise<void> {
    await this.client.createTask({
      parent: this.parent,
      task: {
        httpRequest: {
          httpMethod: "POST",
          url: this.targetUrl,
          headers: {
            "Content-Type": "application/json",
            [WORKER_TASK_AUTH_HEADER]: this.options.workerTaskAuthToken,
          },
          oidcToken: {
            serviceAccountEmail: this.options.invokerServiceAccountEmail,
            audience: this.targetUrl,
          },
        },
      },
    });

    this.options.logger.info({ role: "action-drain-dispatcher" }, "Requested action outbox drain");
  }
}
