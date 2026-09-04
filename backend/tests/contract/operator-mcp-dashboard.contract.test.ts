import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOperatorMcpDashboardRoutes } from "../../src/modules/operatorMcpAuthorization/dashboardRoutes.js";
import { createOperatorMcpSetupRoutes } from "../../src/modules/operatorMcpSetup/routes.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";

const buildApp = () => {
  const grantService = {
    list: vi.fn(async () => ({ grants: [], canViewWorkspace: false })),
    get: vi.fn(async () => ({ id: grantId })),
    revoke: vi.fn(async () => ({ id: grantId, status: "revoked" })),
  };
  const dependencies = {
    env: {
      SESSION_COOKIE_NAME: "radioso_session",
      OPERATOR_MCP_ENABLED: true,
      OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
      OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS: workspaceId,
    },
    authService: { authenticateSession: vi.fn(async () => ({ userId: "user", accountId: "account", sessionId: "session" })) },
    accountAccessService: { requireActiveMembership: vi.fn(async () => undefined) },
    workspaceSessionService: { resolve: vi.fn(async () => ({ accountId: "account", workspaceId })) },
    operatorMcpGrantService: grantService,
    operatorMcpReadiness: Promise.resolve(true),
  };
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/v1", createOperatorMcpSetupRoutes(dependencies as never));
  app.use("/api/v1", createOperatorMcpDashboardRoutes(dependencies as never));
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: "request_failed" });
  });
  return { app, grantService };
};

describe("operator MCP dashboard contract", () => {
  it("requires the existing dashboard workspace session and returns no-secret setup", async () => {
    const { app } = buildApp();
    await request(app).get(`/api/v1/workspaces/${workspaceId}/operator-mcp/setup`).set("x-workspace-id", workspaceId).expect(401);
    const response = await request(app).get(`/api/v1/workspaces/${workspaceId}/operator-mcp/setup`)
      .set("x-workspace-id", workspaceId).set("Cookie", "radioso_session=session-token").expect(200);
    expect(response.body).toMatchObject({ availability: "available", resource: "https://mcp.example/operator/mcp" });
    expect(JSON.stringify(response.body)).not.toContain("session-token");
  });

  it("backs grant inventory/detail and requires CSRF for revocation", async () => {
    const { app, grantService } = buildApp();
    const session = (operation: request.Test) => operation.set("x-workspace-id", workspaceId).set("Cookie", "radioso_session=session-token");
    await session(request(app).get(`/api/v1/workspaces/${workspaceId}/operator-mcp/grants`)).expect(200);
    await session(request(app).get(`/api/v1/workspaces/${workspaceId}/operator-mcp/grants/${grantId}`)).expect(200);
    await session(request(app).post(`/api/v1/workspaces/${workspaceId}/operator-mcp/grants/${grantId}/revoke`)).expect(403);
    await session(request(app).post(`/api/v1/workspaces/${workspaceId}/operator-mcp/grants/${grantId}/revoke`)).set("x-radioso-csrf", "1").expect(200);
    expect(grantService.revoke).toHaveBeenCalledWith(expect.objectContaining({ grantId, workspaceId, actorUserId: "user" }));
  });
});
