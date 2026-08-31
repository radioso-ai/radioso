import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

describe("workspace MCP context contract", () => {
  it("rejects personal and service API credentials while MCP credential support is deferred", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "workspace-mcp-context@example.com");
    const personal = await dependencies.personalCredentialService.issue({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      label: "MCP context personal",
      roleCeiling: "admin",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    const service = await dependencies.serviceAccountService.createWithCredential({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      actorUserId: session.userId,
      displayName: "MCP context service",
      role: "admin",
      credentialLabel: "MCP context credential",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });

    for (const token of [personal.secret, service.secret]) {
      const response = await request(app)
        .get("/api/v1/workspace/mcp/context")
        .set("authorization", `Bearer ${token}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("unauthorized");
    }
  });

  it("rejects unauthenticated MCP context requests", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });

  it("returns context only to the signed-in session for its selected workspace", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "workspace-mcp-context-session@example.com");

    const response = await request(app)
      .get("/api/v1/workspace/mcp/context")
      .set("Cookie", session.cookie)
      .set("X-Workspace-Id", session.workspaceId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ workspaceId: session.workspaceId });
  });

});
