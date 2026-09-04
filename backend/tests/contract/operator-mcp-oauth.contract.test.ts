import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOperatorMcpDiscoveryRoutes, createOperatorMcpOauthRoutes } from "../../src/modules/operatorMcpAuthorization/routes.js";

const env = {
  SESSION_COOKIE_NAME: "radioso_session", OPERATOR_MCP_ENABLED: true,
  OPERATOR_MCP_ISSUER_URL: "https://app.example", OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
};

const createHarness = () => {
  const service = {
    startAuthorization: vi.fn(async () => ({ transactionId: "tx", consentUrl: "https://app.example/oauth/operator-mcp/consent?transaction=tx" })),
    exchangeAuthorizationCode: vi.fn(async () => ({ accessToken: "access", tokenType: "Bearer", expiresIn: 900, refreshToken: null, scope: "operator:read" })),
    refresh: vi.fn(), revoke: vi.fn(async () => undefined), getTransaction: vi.fn(), decide: vi.fn(),
  };
  const dependencies = {
    env, operatorMcpAuthorizationService: service, operatorMcpReadiness: Promise.resolve(true),
    operatorMcpClientResolver: { resolve: vi.fn(async () => ({
      recordId: "client", clientId: "https://client.example/cimd", clientVersion: "1",
      metadataSnapshotId: "snapshot", metadataDigest: "digest", applicationType: "web" as const,
      displayName: "Client", redirectUris: ["https://client.example/callback"],
    })) },
    authService: { authenticateSession: vi.fn() }, accountAccessService: {}, workspaceService: {}, userRepository: {},
  };
  const app = express();
  app.use(express.urlencoded({ extended: false })); app.use(express.json()); app.use(cookieParser());
  app.use("/.well-known", createOperatorMcpDiscoveryRoutes(dependencies as never));
  app.use("/api/v1/operator-mcp/oauth", createOperatorMcpOauthRoutes(dependencies as never));
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: "request_failed" }));
  return { app, dependencies, service };
};

describe("operator MCP OAuth HTTP contract", () => {
  it("advertises authorization code, refresh, S256, and no unimplemented DCR endpoint", async () => {
    const { app } = createHarness();
    const response = await request(app).get("/.well-known/oauth-authorization-server").expect(200);
    expect(response.body).toMatchObject({
      issuer: "https://app.example", grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    expect(response.body).not.toHaveProperty("registration_endpoint");
  });

  it("resolves trusted client metadata before redirecting to consent", async () => {
    const { app, dependencies, service } = createHarness();
    const query = {
      response_type: "code", client_id: "https://client.example/cimd", redirect_uri: "https://client.example/callback",
      scope: "operator:read", state: "state", code_challenge: "a".repeat(43), code_challenge_method: "S256",
      resource: env.OPERATOR_MCP_RESOURCE_URL,
    };
    await request(app).get("/api/v1/operator-mcp/oauth/authorize").query(query).expect(302).expect("location", /\/oauth\/operator-mcp\/consent/u);
    expect(dependencies.operatorMcpClientResolver.resolve).toHaveBeenCalledWith(query.client_id, query.redirect_uri);
    expect(service.startAuthorization).toHaveBeenCalledWith(expect.objectContaining({ resource: env.OPERATOR_MCP_RESOURCE_URL }));
  });

  it("never redirects an authorization error to an unregistered URI", async () => {
    const { app, service } = createHarness();
    const response = await request(app).get("/api/v1/operator-mcp/oauth/authorize").query({
      response_type: "code", client_id: "https://client.example/cimd", redirect_uri: "https://attacker.example/callback",
      scope: "operator:read", state: "state", code_challenge: "a".repeat(43), code_challenge_method: "S256",
      resource: env.OPERATOR_MCP_RESOURCE_URL,
    }).expect(400);
    expect(response.headers.location).toBeUndefined();
    expect(service.startAuthorization).not.toHaveBeenCalled();
  });

  it("accepts form token/revoke requests and never leaks revocation validity", async () => {
    const { app, service } = createHarness();
    const token = await request(app).post("/api/v1/operator-mcp/oauth/token").type("form").send({
      grant_type: "authorization_code", code: "code", client_id: "client", redirect_uri: "https://client.example/callback",
      code_verifier: "a".repeat(43), resource: env.OPERATOR_MCP_RESOURCE_URL,
    }).expect(200);
    expect(token.body).toEqual({ access_token: "access", token_type: "Bearer", expires_in: 900, scope: "operator:read" });
    await request(app).post("/api/v1/operator-mcp/oauth/revoke").type("form").send({ token: "unknown" }).expect(200);
    expect(service.revoke).toHaveBeenCalledWith("unknown", expect.any(Date));
  });
});
