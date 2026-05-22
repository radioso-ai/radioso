import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

describe("connector management contract", () => {
  it("returns an empty registry when no connector capabilities are registered", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "connectors-list@example.com");

    const response = await request(app)
      .get("/api/v1/connectors")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connectors: [],
    });
  });

  it("rejects unknown connector operations", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "connectors-unknown@example.com");

    const detail = await request(app)
      .get("/api/v1/connectors/removed")
      .set(adminSessionHeaders(session));
    const save = await request(app)
      .put("/api/v1/connectors/removed")
      .set(adminSessionHeaders(session))
      .send({ config: {} });
    const enable = await request(app)
      .post("/api/v1/connectors/removed/enable")
      .set(adminSessionHeaders(session));

    expect(detail.status).toBe(404);
    expect(save.status).toBe(404);
    expect(enable.status).toBe(404);
  });

  it("exposes sync state and accepts a manual connector sync request", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "connectors-sync@example.com");
    const workspaceId = session.workspaceId;

    dependencies.connectorRegistry.register({
      id: "manual",
      name: "Manual",
      description: "Manual sync connector",
      configSchema: () => [
        { key: "channel", label: "Channel", type: "text", required: true },
      ],
      migrate: async () => {},
      initialize: async () => {},
      shutdown: async () => {},
      getWebhookPath: () => "/api/connectors/manual/:workspaceId/webhook",
      uniqueChannelField: () => null,
      validateConfig: () => [],
      syncNow: async () => ({ ingested: 2 }),
    });

    const connectorDb = dependencies.connectorDb as unknown as {
      configs: Map<string, unknown>;
      syncStates: Map<string, unknown>;
    };
    connectorDb.configs.set(`${workspaceId}:manual`, {
      id: "config-1",
      workspaceId,
      connectorId: "manual",
      enabled: true,
      configData: { channel: "alpha" },
      errorStatus: "last_error",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    connectorDb.syncStates.set(`${workspaceId}:manual`, {
      workspaceId,
      connectorId: "manual",
      backfillCompletedAt: new Date("2026-05-20T12:00:00.000Z"),
      lastRunAt: new Date("2026-05-21T12:00:00.000Z"),
      lastModifiedAt: new Date("2026-05-19T12:00:00.000Z"),
      lastIngestedCount: 4,
    });

    const detail = await request(app)
      .get("/api/v1/connectors/manual")
      .set(adminSessionHeaders(session));
    const sync = await request(app)
      .post("/api/v1/connectors/manual/sync")
      .set(adminSessionHeaders(session));

    expect(detail.status).toBe(200);
    expect(detail.body.syncState).toEqual(expect.objectContaining({
      lastErrorStatus: "last_error",
      lastIngestedCount: 4,
    }));
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ ingested: 2 });
  });
});
