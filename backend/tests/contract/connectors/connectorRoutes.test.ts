import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

const acceptInvite = async (
  app: ReturnType<typeof createTestApp>["app"],
  ownerCookie: string,
  email: string,
  role: "admin" | "member",
) => {
  const invite = await request(app)
    .post("/api/v1/account/invitations")
    .set("Cookie", ownerCookie)
    .send({ email, role });
  expect(invite.status).toBe(201);

  const token = String(invite.body.acceptanceUrl).split("/").at(-1)!;
  const password = "verysecurepassword";
  const accepted = await request(app)
    .post(`/api/v1/auth/invitations/${token}/accept`)
    .send({ email, password });
  expect(accepted.status).toBe(200);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password, preferredAccountId: accepted.body.accountId });
  expect(login.status).toBe(200);

  return {
    cookie: login.headers["set-cookie"][0] as string,
    workspaceId: accepted.body.workspaceId as string,
  };
};

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
      syncNow: async () => ({ accepted: true }),
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
      syncRequestedAt: null,
      syncStartedAt: null,
      syncLockToken: null,
      lastRunAt: new Date("2026-05-21T12:00:00.000Z"),
      lastModifiedAt: new Date("2026-05-19T12:00:00.000Z"),
      lastIngestedCount: 4,
      lastError: "WordPress REST returned 401 Unauthorized.",
    });

    const detail = await request(app)
      .get("/api/v1/connectors/manual")
      .set(adminSessionHeaders(session));
    const sync = await request(app)
      .post("/api/v1/connectors/manual/sync")
      .set(adminSessionHeaders(session));

    expect(detail.status).toBe(200);
    expect(detail.body.syncState).toEqual(expect.objectContaining({
      lastIngestedCount: 4,
      lastError: "WordPress REST returned 401 Unauthorized.",
    }));
    expect(detail.body.errorStatus).toBe("last_error");
    expect(sync.status).toBe(202);
    expect(sync.body).toEqual({ accepted: true });
  });

  it("requires credential-management permission for connector secrets and mutations", async () => {
    const { app, dependencies } = createTestApp();
    const owner = await issueTestSession(app, `connector-owner-${Date.now()}@example.com`);
    const member = await acceptInvite(app, owner.cookie, `connector-member-${Date.now()}@example.com`, "member");
    const memberHeaders = { Cookie: member.cookie, "X-Workspace-Id": member.workspaceId };

    dependencies.connectorRegistry.register({
      id: "sensitive",
      name: "Sensitive",
      description: "Connector with generated delivery credentials",
      configSchema: () => [
        { key: "channel", label: "Channel", type: "text", required: true },
        { key: "webhookSecret", label: "Webhook Secret", type: "generated_secret", required: true },
      ],
      migrate: async () => {},
      initialize: async () => {},
      shutdown: async () => {},
      getWebhookPath: () => "/api/connectors/sensitive/:workspaceId/webhook",
      uniqueChannelField: () => null,
      validateConfig: () => [],
      syncNow: async () => ({ accepted: true }),
    });

    const list = await request(app)
      .get("/api/v1/connectors")
      .set(memberHeaders);
    expect(list.status).toBe(200);

    const detail = await request(app)
      .get("/api/v1/connectors/sensitive")
      .set(memberHeaders);
    expect(detail.status).toBe(403);

    const save = await request(app)
      .put("/api/v1/connectors/sensitive")
      .set(memberHeaders)
      .send({ config: { channel: "alpha" } });
    expect(save.status).toBe(403);

    const sync = await request(app)
      .post("/api/v1/connectors/sensitive/sync")
      .set(memberHeaders);
    expect(sync.status).toBe(403);
  }, 20_000);
});
