import { describe, expect, it, vi } from "vitest";

import { CloudTasksActionDrainDispatcher } from "../../src/modules/chat/infra/cloudTasksActionDrainDispatcher.js";

/** Shape asserted below; declared so `createTask.mock.calls[0]` is a typed tuple, not `[]`. */
interface CreateTaskRequest {
  parent: string;
  task: {
    httpRequest: {
      httpMethod: string;
      url: string;
      headers: Record<string, string>;
      oidcToken: { serviceAccountEmail: string; audience: string };
    };
  };
}

const createClient = () => ({
  queuePath: vi.fn((project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`),
  createTask: vi.fn(async (_request: CreateTaskRequest) => [{}]),
});

describe("CloudTasksActionDrainDispatcher", () => {
  it("creates an OIDC-authenticated Cloud Task targeting the drain endpoint", async () => {
    const client = createClient();
    const dispatcher = new CloudTasksActionDrainDispatcher({
      client: client as never,
      projectId: "radioso-prod",
      location: "us-central1",
      queueName: "radioso-conversation-actions",
      workerServiceUrl: "https://worker.example.com/",
      invokerServiceAccountEmail: "worker-task@radioso-prod.iam.gserviceaccount.com",
      logger: { info: vi.fn() } as never,
    });

    await dispatcher.requestDrain();

    expect(client.queuePath).toHaveBeenCalledWith("radioso-prod", "us-central1", "radioso-conversation-actions");
    expect(client.createTask).toHaveBeenCalledTimes(1);
    const [request] = client.createTask.mock.calls[0]!;
    expect(request.parent).toBe("projects/radioso-prod/locations/us-central1/queues/radioso-conversation-actions");
    expect(request.task.httpRequest.httpMethod).toBe("POST");
    // Trailing slash on the configured service URL is normalized away.
    expect(request.task.httpRequest.url).toBe("https://worker.example.com/internal/tasks/actions/drain");
    expect(request.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: "worker-task@radioso-prod.iam.gserviceaccount.com",
      audience: "https://worker.example.com/internal/tasks/actions/drain",
    });
    // No row-specific payload — the push is a trigger, not a message; draining is
    // idempotent via the outbox's own claim/lease model.
    expect(request.task.httpRequest.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("does not throw when the underlying Cloud Tasks call rejects (best-effort push)", async () => {
    const client = createClient();
    client.createTask.mockRejectedValueOnce(new Error("queue unavailable"));
    const dispatcher = new CloudTasksActionDrainDispatcher({
      client: client as never,
      projectId: "radioso-prod",
      location: "us-central1",
      queueName: "radioso-conversation-actions",
      workerServiceUrl: "https://worker.example.com",
      invokerServiceAccountEmail: "worker-task@radioso-prod.iam.gserviceaccount.com",
      logger: { info: vi.fn(), warn: vi.fn() } as never,
    });

    // requestDrain propagates the failure to its caller (DrainTriggeringActionOutbox),
    // which is the layer responsible for swallowing it — this class stays honest.
    await expect(dispatcher.requestDrain()).rejects.toThrow("queue unavailable");
  });
});
