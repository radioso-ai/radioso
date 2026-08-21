import { afterAll, expect, it, vi } from "vitest";

import { PostgresWorkspaceEventBus } from "../../src/shared/infra/postgresWorkspaceEventBus.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PostgresWorkspaceEventBus", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const bus = new PostgresWorkspaceEventBus(database, {
    info: vi.fn(),
    warn: vi.fn(),
  } as never);

  afterAll(async () => {
    await bus.close();
    await database.close();
  });

  it("round-trips a content-free frame only to the subscribed workspace", async () => {
    const subscribed = bus.subscribe("workspace-a")[Symbol.asyncIterator]();
    const otherWorkspace = bus.subscribe("workspace-b")[Symbol.asyncIterator]();

    await bus.ready();
    await bus.publish({
      resourceType: "document",
      resourceId: "document-1",
      workspaceId: "workspace-a",
      changeKind: "document.status_changed",
    });

    const received = await Promise.race([
      subscribed.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for workspace event")), 2_000)),
    ]);
    expect(received).toMatchObject({
      done: false,
      value: {
        resourceType: "document",
        resourceId: "document-1",
        workspaceId: "workspace-a",
        changeKind: "document.status_changed",
      },
    });
    expect((received as { value: { version: number } }).value.version).toBeGreaterThan(0);

    await expect(Promise.race([
      otherWorkspace.next(),
      new Promise((resolve) => setTimeout(resolve, 25, "no-event")),
    ])).resolves.toBe("no-event");
    await subscribed.return?.();
    await otherWorkspace.return?.();
  });
});
