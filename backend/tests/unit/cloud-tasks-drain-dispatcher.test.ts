import { describe, expect, it, vi } from "vitest";

import { CloudTasksDrainDispatcher } from "../../src/shared/infra/cloudTasksDrainDispatcher.js";
import { WORKER_TASK_AUTH_HEADER } from "../../src/shared/infra/workerTaskAuth.js";

const workerTaskAuthToken = "0123456789abcdef0123456789abcdef";

/** Shape asserted below; declared so `createTask.mock.calls[0]` is a typed tuple, not `[]`. */
interface CreateTaskRequest {
  parent: string;
  task: {
    scheduleTime?: { seconds: number; nanos: number };
    httpRequest: {
      httpMethod: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
      oidcToken: { serviceAccountEmail: string; audience: string };
    };
  };
}

interface ExampleDrainBody {
  workspaceId: string;
  maxJobs: number;
}

const createClient = () => ({
  queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
  createTask: vi.fn(async (_request: CreateTaskRequest) => [{}]),
});

const createDispatcher = <Body>(client: ReturnType<typeof createClient>) =>
  new CloudTasksDrainDispatcher<Body>({
    client: client as never,
    projectId: "radioso-prod",
    location: "europe-west1",
    queueName: "radioso-worker",
    workerServiceUrl: "https://worker.example.com//",
    invokerServiceAccountEmail: "worker-task@radioso-prod.iam.gserviceaccount.com",
    workerTaskAuthToken,
    taskPath: "/internal/tasks/example/drain",
  });

const firstRequest = (client: ReturnType<typeof createClient>): CreateTaskRequest => {
  expect(client.createTask).toHaveBeenCalledTimes(1);
  const [request] = client.createTask.mock.calls[0];
  return request;
};

const decodeBody = (encoded: string | undefined): unknown =>
  JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf8"));

describe("CloudTasksDrainDispatcher", () => {
  it("targets the task path on the worker with an OIDC audience and the worker token header", async () => {
    const client = createClient();
    const dispatcher = createDispatcher<ExampleDrainBody>(client);

    await dispatcher.requestDrain({ body: { workspaceId: "ws_1", maxJobs: 5 } });

    expect(client.queuePath).toHaveBeenCalledWith("radioso-prod", "europe-west1", "radioso-worker");
    const request = firstRequest(client);
    expect(request.parent).toBe("projects/radioso-prod/locations/europe-west1/queues/radioso-worker");
    expect(request.task.httpRequest.httpMethod).toBe("POST");
    // Trailing slashes on the configured service URL are normalized away.
    expect(request.task.httpRequest.url).toBe("https://worker.example.com/internal/tasks/example/drain");
    expect(request.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: "worker-task@radioso-prod.iam.gserviceaccount.com",
      audience: "https://worker.example.com/internal/tasks/example/drain",
    });
    expect(request.task.httpRequest.headers).toEqual({
      "Content-Type": "application/json",
      [WORKER_TASK_AUTH_HEADER]: workerTaskAuthToken,
    });
  });

  it("sends the body as base64-encoded JSON", async () => {
    const client = createClient();
    const dispatcher = createDispatcher<ExampleDrainBody>(client);

    await dispatcher.requestDrain({ body: { workspaceId: "ws_1", maxJobs: 5 } });

    expect(decodeBody(firstRequest(client).task.httpRequest.body)).toEqual({ workspaceId: "ws_1", maxJobs: 5 });
  });

  it("omits the body when the drain carries no payload", async () => {
    const client = createClient();
    const dispatcher = createDispatcher<never>(client);

    await dispatcher.requestDrain();

    expect(firstRequest(client).task.httpRequest).not.toHaveProperty("body");
  });

  it("sets scheduleTime when scheduleAt is in the future", async () => {
    const client = createClient();
    const dispatcher = createDispatcher<ExampleDrainBody>(client);
    const scheduleAt = new Date("2999-01-01T00:00:01.234Z");

    const receipt = await dispatcher.requestDrain({ body: { workspaceId: "ws_1", maxJobs: 1 }, scheduleAt });

    expect(firstRequest(client).task.scheduleTime).toEqual({
      seconds: Math.floor(scheduleAt.getTime() / 1_000),
      nanos: 234_000_000,
    });
    expect(receipt).toEqual({ scheduled: true });
  });

  it("dispatches immediately when scheduleAt is in the past", async () => {
    const client = createClient();
    const dispatcher = createDispatcher<ExampleDrainBody>(client);

    const receipt = await dispatcher.requestDrain({
      body: { workspaceId: "ws_1", maxJobs: 1 },
      scheduleAt: new Date("2000-01-01T00:00:00.000Z"),
    });

    expect(firstRequest(client).task).not.toHaveProperty("scheduleTime");
    expect(receipt).toEqual({ scheduled: false });
  });

  it("dispatches immediately when no scheduleAt is given", async () => {
    const client = createClient();
    const dispatcher = createDispatcher<ExampleDrainBody>(client);

    const receipt = await dispatcher.requestDrain({ body: { workspaceId: "ws_1", maxJobs: 1 } });

    expect(firstRequest(client).task).not.toHaveProperty("scheduleTime");
    expect(receipt).toEqual({ scheduled: false });
  });

  it("propagates a Cloud Tasks failure to the caller", async () => {
    const client = createClient();
    client.createTask.mockRejectedValueOnce(new Error("queue unavailable"));
    const dispatcher = createDispatcher<ExampleDrainBody>(client);

    await expect(dispatcher.requestDrain({ body: { workspaceId: "ws_1", maxJobs: 1 } })).rejects.toThrow("queue unavailable");
  });
});
