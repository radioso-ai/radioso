import { describe, expect, it, vi } from "vitest";

import { CloudTasksDocumentJobDispatcher } from "../../src/modules/documents/infra/cloudTasksDocumentJobDispatcher.js";
import { CloudTasksWebsiteCrawlJobDispatcher } from "../../src/modules/websiteCrawler/jobQueue.js";
import { WORKER_TASK_AUTH_HEADER } from "../../src/shared/infra/workerTaskAuth.js";

const workerTaskAuthToken = "0123456789abcdef0123456789abcdef";

const createClient = () => ({
  queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
  createTask: vi.fn(async (_request: unknown) => [{}]),
});

describe("Cloud Tasks worker authentication", () => {
  it("adds the worker token while retaining OIDC on document tasks", async () => {
    const client = createClient();
    const dispatcher = new CloudTasksDocumentJobDispatcher({
      client: client as never,
      projectId: "radioso-prod",
      location: "us-central1",
      queueName: "documents",
      workerServiceUrl: "https://worker.example.com",
      invokerServiceAccountEmail: "task-invoker@radioso-prod.iam.gserviceaccount.com",
      workerTaskAuthToken,
      logger: { info: vi.fn() } as never,
    });

    await dispatcher.dispatch({
      jobId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      revision: 1,
    });

    const request = client.createTask.mock.calls[0]?.[0] as {
      task: { httpRequest: { body: string; headers: Record<string, string>; oidcToken: unknown } };
    };
    expect(request.task.httpRequest.headers).toEqual({
      "Content-Type": "application/json",
      [WORKER_TASK_AUTH_HEADER]: workerTaskAuthToken,
    });
    expect(request.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: "task-invoker@radioso-prod.iam.gserviceaccount.com",
      audience: "https://worker.example.com/internal/tasks/document-processing",
    });
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body, "base64").toString("utf8"))).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "33333333-3333-4333-8333-333333333333",
      revision: 1,
    });
  });

  it("adds the worker token while retaining OIDC on crawler tasks", async () => {
    const client = createClient();
    const dispatcher = new CloudTasksWebsiteCrawlJobDispatcher({
      client: client as never,
      projectId: "radioso-prod",
      location: "us-central1",
      queueName: "crawls",
      workerServiceUrl: "https://crawler.example.com",
      invokerServiceAccountEmail: "task-invoker@radioso-prod.iam.gserviceaccount.com",
      workerTaskAuthToken,
      logger: { info: vi.fn() } as never,
    });

    await dispatcher.dispatch({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });

    const request = client.createTask.mock.calls[0]?.[0] as {
      task: { httpRequest: { body: string; headers: Record<string, string>; oidcToken: unknown } };
    };
    expect(request.task.httpRequest.headers).toEqual({
      "Content-Type": "application/json",
      [WORKER_TASK_AUTH_HEADER]: workerTaskAuthToken,
    });
    expect(request.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: "task-invoker@radioso-prod.iam.gserviceaccount.com",
      audience: "https://crawler.example.com/internal/tasks/website-crawl",
    });
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body, "base64").toString("utf8"))).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });
  });
});
