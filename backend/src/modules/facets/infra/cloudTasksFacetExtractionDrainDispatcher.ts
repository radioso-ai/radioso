import { CloudTasksClient } from "@google-cloud/tasks";

import type { AppLogger } from "../../../shared/observability/logger.js";
import { WORKER_TASK_AUTH_HEADER } from "../../../shared/infra/workerTaskAuth.js";
import type { FacetExtractionDrainDispatcher } from "../contracts.js";

const FACET_EXTRACTION_DRAIN_TASK_PATH = "/internal/tasks/facet-extraction/drain";

export interface CloudTasksFacetExtractionDrainDispatcherOptions {
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
 * A task is only a drain hint. The durable jobs table remains authoritative, so
 * duplicate Cloud Tasks and concurrent workspace requests are harmless.
 */
export class CloudTasksFacetExtractionDrainDispatcher implements FacetExtractionDrainDispatcher {
  private readonly client: CloudTasksClient;
  private readonly parent: string;
  private readonly targetUrl: string;

  constructor(private readonly options: CloudTasksFacetExtractionDrainDispatcherOptions) {
    this.client = options.client ?? new CloudTasksClient();
    this.parent = this.client.queuePath(options.projectId, options.location, options.queueName);
    this.targetUrl = `${normalizeUrl(options.workerServiceUrl)}${FACET_EXTRACTION_DRAIN_TASK_PATH}`;
  }

  async requestWorkspaceDrain(input: {
    workspaceId: string;
    analysisStart: Date;
    analysisEnd: Date;
    scheduleAt?: Date;
  }): Promise<void> {
    const scheduleTime = input.scheduleAt && input.scheduleAt.getTime() > Date.now()
      ? {
          seconds: Math.floor(input.scheduleAt.getTime() / 1_000),
          nanos: (input.scheduleAt.getTime() % 1_000) * 1_000_000,
        }
      : undefined;
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
          body: Buffer.from(JSON.stringify({
            workspaceId: input.workspaceId,
            analysisStart: input.analysisStart.toISOString(),
            analysisEnd: input.analysisEnd.toISOString(),
          }), "utf8").toString("base64"),
          oidcToken: {
            serviceAccountEmail: this.options.invokerServiceAccountEmail,
            audience: this.targetUrl,
          },
        },
      },
    });
    this.options.logger.info(
      { role: "facet-drain-dispatcher", workspaceId: input.workspaceId, scheduled: Boolean(scheduleTime) },
      "Requested facet extraction drain",
    );
  }
}
