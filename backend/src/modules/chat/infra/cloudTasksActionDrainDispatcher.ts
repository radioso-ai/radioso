import { CloudTasksClient } from "@google-cloud/tasks";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ActionDrainDispatcherPort } from "../services/actions/actionDrainDispatcher.js";

const ACTION_DRAIN_TASK_PATH = "/internal/tasks/actions/drain";

export interface CloudTasksActionDrainDispatcherOptions {
  client?: CloudTasksClient;
  projectId: string;
  location: string;
  queueName: string;
  workerServiceUrl: string;
  invokerServiceAccountEmail: string;
  logger: AppLogger;
}

const normalizeUrl = (value: string): string => value.replace(/\/+$/, "");

/**
 * Pushes a Cloud Task per action-emitting turn, mirroring
 * `CloudTasksDocumentJobDispatcher` (documents module) exactly: same OIDC-token
 * shape (service account + URL audience), same queue/parent construction. The
 * task body carries no row-specific payload — see {@link ActionDrainDispatcherPort}.
 * Auth for the receiving endpoint is enforced entirely by Cloud Run IAM (only the
 * `worker_task_invoker` service account may invoke the worker task service); this
 * class supplies the OIDC token Cloud Run's platform-level check verifies, and adds
 * no application-level auth of its own — same as the document-processing dispatcher.
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
