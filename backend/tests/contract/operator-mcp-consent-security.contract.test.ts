import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOperatorMcpOauthRoutes } from "../../src/modules/operatorMcpAuthorization/routes.js";

const transactionId = "00000000-0000-4000-8000-000000000001";
const transaction: {
  id: string; clientId: string; clientDisplayName: string; clientVersion: string;
  clientUri: string | null; clientMetadataDigest: string; applicationType: "web"; redirectUri: string;
  requestedToolScopes: string[]; requestedOfflineAccess: boolean; resource: string;
  status: "pending"; expiresAt: Date; userId: string | null; accountId: string | null; sessionId: string | null;
} = {
  id: transactionId, clientId: "https://client.example/cimd", clientDisplayName: "Client", clientVersion: "1",
  clientUri: "https://client.example/app",
  clientMetadataDigest: "digest", applicationType: "web", redirectUri: "https://client.example/callback",
  requestedToolScopes: ["operator:read"], requestedOfflineAccess: false, resource: "https://mcp.example/operator/mcp",
  status: "pending", expiresAt: new Date(Date.now() + 60_000), userId: null, accountId: null, sessionId: null,
};

const harness = (bound: Partial<typeof transaction> = {}) => {
  const service = {
    getTransaction: vi.fn(async () => ({ ...transaction, ...bound })),
    decide: vi.fn(async () => ({ redirectUrl: "https://client.example/callback?code=opaque&state=state" })),
    startAuthorization: vi.fn(), exchangeAuthorizationCode: vi.fn(), refresh: vi.fn(), revoke: vi.fn(),
  };
  const dependencies = {
    env: {
      SESSION_COOKIE_NAME: "session",
      OPERATOR_MCP_ENABLED: true,
      OPERATOR_MCP_ROLLOUT_WORKSPACE_IDS: "00000000-0000-4000-8000-000000000002",
    }, service,
    operatorMcpAuthorizationService: service, operatorMcpReadiness: Promise.resolve(true), operatorMcpClientResolver: { resolve: vi.fn() },
    authService: { authenticateSession: vi.fn(async () => ({ userId: "user", accountId: "account", sessionId: "browser-session" })) },
    accountAccessService: {
      requireActiveMembership: vi.fn(async () => ({ id: "membership" })),
      resolveWorkspaceRole: vi.fn(async () => "member"),
    },
    workspaceService: { listForAccount: vi.fn(async () => [{ id: "00000000-0000-4000-8000-000000000002", name: "Workspace" }]) },
    userRepository: { findById: vi.fn(async () => ({ id: "user", email: "operator@example.com" })) },
  };
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use("/api/v1/operator-mcp/oauth", createOperatorMcpOauthRoutes(dependencies as never));
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 400).json({ error: "request_failed" }));
  return { app, service };
};

describe("operator MCP consent security contract", () => {
  it("requires a session and emits no-store consent data", async () => {
    const { app } = harness();
    await request(app).get(`/api/v1/operator-mcp/oauth/transactions/${transactionId}`).expect(401);
    const response = await request(app).get(`/api/v1/operator-mcp/oauth/transactions/${transactionId}`).set("Cookie", "session=value").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      transactionId,
      client: { clientUri: "https://client.example/app" },
      currentUser: { id: "user" },
    });
  });

  it("rejects account/session swaps and requires CSRF before a decision", async () => {
    const swapped = harness({ sessionId: "another-session", accountId: "account", userId: "user" });
    await request(swapped.app).get(`/api/v1/operator-mcp/oauth/transactions/${transactionId}`).set("Cookie", "session=value").expect(400);
    const { app, service } = harness();
    const path = `/api/v1/operator-mcp/oauth/transactions/${transactionId}/decision`;
    const body = { decision: "approve", workspaceId: "00000000-0000-4000-8000-000000000002", approvedToolScopes: ["operator:read"], offlineAccess: false };
    await request(app).post(path).set("Cookie", "session=value").send(body).expect(403);
    await request(app).post(path).set("Cookie", "session=value").set("x-radioso-csrf", "1").send(body).expect(200);
    expect(service.decide).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "browser-session", membershipId: "membership" }));
  });
});
