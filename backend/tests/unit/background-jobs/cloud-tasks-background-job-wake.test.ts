import { describe, expect, it, vi } from "vitest";

import { CloudTasksBackgroundJobWake } from "../../../src/shared/infra/cloudTasksBackgroundJobWake.js";
import { WORKER_TASK_AUTH_HEADER } from "../../../src/shared/infra/workerTaskAuth.js";

const workerTaskAuthToken = "0123456789abcdef0123456789abcdef";

interface CreateTaskRequest {
  parent: string;
  task: {
    scheduleTime?: { seconds: number; nanos: number };
    dispatchDeadline?: { seconds: number };
    httpRequest: {
      url: string;
      headers: Record<string, string>;
      body?: string;
      oidcToken: { serviceAccountEmail: string; audience: string };
    };
  };
}

const createWake = () => {
  const client = {
    queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
    createTask: vi.fn(async (_request: CreateTaskRequest) => [{}]),
  };
  const wake = new CloudTasksBackgroundJobWake({
    client: client as never,
    projectId: "radioso-prod",
    location: "us-central1",
    queueName: "radioso-background-jobs",
    workerServiceUrl: "https://worker.example.com",
    invokerServiceAccountEmail: "worker-task@radioso-prod.iam.gserviceaccount.com",
    workerTaskAuthToken,
  });
  return { client, wake };
};

describe("CloudTasksBackgroundJobWake", () => {
  it("pushes an authenticated drain to the worker's background-job route with no job content", async () => {
    const { client, wake } = createWake();

    await wake.requestDrain();

    const [request] = client.createTask.mock.calls[0];
    expect(request.parent).toBe("projects/radioso-prod/locations/us-central1/queues/radioso-background-jobs");
    expect(request.task.httpRequest.url).toBe("https://worker.example.com/internal/tasks/background-jobs/drain");
    expect(request.task.httpRequest.oidcToken.audience).toBe("https://worker.example.com/internal/tasks/background-jobs/drain");
    expect(request.task.httpRequest.headers[WORKER_TASK_AUTH_HEADER]).toBe(workerTaskAuthToken);
    expect(request.task.httpRequest.body).toBeUndefined();
    expect(request.task.scheduleTime).toBeUndefined();
  });

  it("gives the worker as long as one drain can take before Cloud Tasks retries the wake", async () => {
    const { client, wake } = createWake();

    await wake.requestDrain();

    const [request] = client.createTask.mock.calls[0];
    expect(request.task.dispatchDeadline).toEqual({ seconds: 300 });
  });

  it("schedules the drain for a retry's due time", async () => {
    const { client, wake } = createWake();
    const notBefore = new Date(Date.now() + 60_000);

    await wake.requestDrain({ notBefore });

    const [request] = client.createTask.mock.calls[0];
    expect(request.task.scheduleTime?.seconds).toBe(Math.floor(notBefore.getTime() / 1_000));
  });
});
