import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryWorkspaceEventBus,
  pushEventSchema,
} from "../../src/shared/events/workspaceEventBus.js";
import { PostgresWorkspaceEventBus } from "../../src/shared/infra/postgresWorkspaceEventBus.js";

class FakeListenerClient extends EventEmitter {
  async connect(): Promise<void> {}

  async query(_query: string): Promise<void> {}

  async end(): Promise<void> {}
}

class HangingListenerClient extends EventEmitter {
  async connect(): Promise<void> {
    await new Promise(() => undefined);
  }

  async query(_query: string): Promise<void> {}

  async end(): Promise<void> {}
}

describe("Workspace event buses", () => {
  it("delivers only events for the subscribed workspace", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const iterator = bus.subscribe("workspace-a")[Symbol.asyncIterator]();

    await bus.publish({
      resourceType: "document",
      resourceId: "document-a",
      workspaceId: "workspace-b",
      changeKind: "document.status_changed",
    });
    await bus.publish({
      resourceType: "document",
      resourceId: "document-a",
      workspaceId: "workspace-a",
      changeKind: "document.status_changed",
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        resourceType: "document",
        resourceId: "document-a",
        workspaceId: "workspace-a",
        changeKind: "document.status_changed",
        version: 2,
      },
    });

    await iterator.return?.();
    await bus.close();
  });

  it("accepts only identity-only frames", () => {
    expect(pushEventSchema.safeParse({
      resourceType: "document",
      resourceId: "document-a",
      workspaceId: "workspace-a",
      changeKind: "document.status_changed",
      version: 1,
    }).success).toBe(true);

    expect(pushEventSchema.safeParse({
      resourceType: "document",
      resourceId: "document-a",
      workspaceId: "workspace-a",
      changeKind: "document.status_changed",
      version: 1,
      content: "must never be sent",
    }).success).toBe(false);
  });

  it("drops stale buffered events, retains the newest event, and signals a resync when a subscriber queue overflows", async () => {
    const listener = new FakeListenerClient();
    const telemetryService = { emit: vi.fn().mockResolvedValue(null) };
    const bus = new PostgresWorkspaceEventBus({
      createListenerClient: () => listener,
    } as never, {
      info: vi.fn(),
      warn: vi.fn(),
    } as never, telemetryService as never);
    const subscription = bus.subscribe("workspace-a");
    const iterator = subscription[Symbol.asyncIterator]();

    await bus.ready();
    for (let version = 1; version <= 257; version += 1) {
      listener.emit("notification", {
        channel: "workspace_push_events",
        payload: JSON.stringify({
          resourceType: "document",
          resourceId: `document-${version}`,
          workspaceId: "workspace-a",
          changeKind: "document.status_changed",
          version,
        }),
      });
    }

    expect(subscription.consumeResync?.()).toBe(true);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        resourceType: "document",
        resourceId: "document-257",
        workspaceId: "workspace-a",
        changeKind: "document.status_changed",
        version: 257,
      },
    });
    expect(subscription.consumeResync?.()).toBe(false);
    listener.emit("notification", {
      channel: "workspace_push_events",
      payload: "not-json",
    });
    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "workspace_push.listener_connected",
    }));
    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "workspace_push.subscriber_queue_overflow",
      severity: "warn",
    }));
    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "workspace_push.listener_payload_parse_failed",
      severity: "warn",
    }));

    await iterator.return?.();
    await bus.close();
  });

  it("lets callers cancel readiness waits when they fall back to polling", async () => {
    const listener = new HangingListenerClient();
    const bus = new PostgresWorkspaceEventBus({
      createListenerClient: () => listener,
    } as never, {
      info: vi.fn(),
      warn: vi.fn(),
    } as never);
    const controller = new AbortController();

    const ready = bus.ready({ signal: controller.signal });
    controller.abort();

    await expect(ready).resolves.toBeUndefined();
    await bus.close();
  });

  it("terminates current subscriptions when the LISTEN connection is lost", async () => {
    const listener = new FakeListenerClient();
    const bus = new PostgresWorkspaceEventBus({
      createListenerClient: () => listener,
    } as never, {
      info: vi.fn(),
      warn: vi.fn(),
    } as never);
    const iterator = bus.subscribe("workspace-a")[Symbol.asyncIterator]();
    await bus.ready();

    const pending = iterator.next();
    listener.emit("error", new Error("connection lost"));

    await expect(Promise.race([
      pending,
      new Promise((resolve) => setTimeout(resolve, 50, "still-open")),
    ])).resolves.toEqual({ done: true, value: undefined });
    await bus.close();
  });

  it("keeps mutation latency independent of a slow publisher and coalesces a hot key", async () => {
    let releaseFirst!: () => void;
    const firstPublishBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const notificationPublisher = vi.fn()
      .mockImplementationOnce(() => firstPublishBlocked)
      .mockResolvedValue(undefined);
    const bus = new PostgresWorkspaceEventBus({} as never, {
      info: vi.fn(),
      warn: vi.fn(),
    } as never, undefined, notificationPublisher);

    await bus.publish({
      resourceType: "document",
      resourceId: "document-0",
      workspaceId: "workspace-a",
      changeKind: "document.status_changed",
    });
    for (let index = 1; index <= 500; index += 1) {
      await bus.publish({
        resourceType: "document",
        resourceId: `document-${index}`,
        workspaceId: "workspace-a",
        changeKind: "document.status_changed",
      });
    }

    expect(notificationPublisher).toHaveBeenCalledTimes(1);
    releaseFirst();
    await vi.waitFor(() => expect(notificationPublisher).toHaveBeenCalledTimes(2));
    expect(notificationPublisher).toHaveBeenLastCalledWith([
      expect.objectContaining({ resourceId: "document-500" }),
    ]);
    await bus.close();
  });
});
