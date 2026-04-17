import { CloudTasksClient } from "@google-cloud/tasks";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { DocumentJobDispatchRequest, DocumentJobDispatcherPort } from "../services/documentJobDispatcher.js";

const WORKER_TASK_PATH = "/internal/tasks/document-processing";

export interface CloudTasksDocumentJobDispatcherOptions {
  client?: CloudTasksClient;
  projectId: string;
  location: string;
  queueName: string;
  workerServiceUrl: string;
  invokerServiceAccountEmail: string;
  logger: AppLogger;
}

const toBase64Json = (input: unknown): string => Buffer.from(JSON.stringify(input), "utf8").toString("base64");

const normalizeUrl = (value: string): string => value.replace(/\/+$/, "");

export class CloudTasksDocumentJobDispatcher implements DocumentJobDispatcherPort {
  private readonly client: CloudTasksClient;
  private readonly parent: string;
  private readonly targetUrl: string;

  constructor(private readonly options: CloudTasksDocumentJobDispatcherOptions) {
    this.client = options.client ?? new CloudTasksClient();
    this.parent = this.client.queuePath(options.projectId, options.location, options.queueName);
    this.targetUrl = `${normalizeUrl(options.workerServiceUrl)}${WORKER_TASK_PATH}`;
  }

  async dispatch(input: DocumentJobDispatchRequest): Promise<void> {
    const scheduleTime = input.scheduleAt
      ? {
          seconds: Math.floor(input.scheduleAt.getTime() / 1000),
          nanos: (input.scheduleAt.getTime() % 1000) * 1_000_000,
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
          },
          body: toBase64Json({
            jobId: input.jobId,
            documentId: input.documentId,
            workspaceId: input.workspaceId,
            revision: input.revision,
          }),
          oidcToken: {
            serviceAccountEmail: this.options.invokerServiceAccountEmail,
            audience: this.targetUrl,
          },
        },
      },
    });

    this.options.logger.info(
      {
        role: "dispatcher",
        jobId: input.jobId,
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        revision: input.revision,
        scheduled: Boolean(input.scheduleAt),
      },
      "Dispatched document processing job",
    );
  }

  async dispatchMany(inputs: DocumentJobDispatchRequest[]): Promise<void> {
    for (const input of inputs) {
      await this.dispatch(input);
    }
  }
}
