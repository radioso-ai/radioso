import { describe, expect, it } from "vitest";

import {
  InMemoryWorkspaceEventBus,
  pushEventSchema,
} from "../../src/shared/events/workspaceEventBus.js";

describe("InMemoryWorkspaceEventBus", () => {
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
});
