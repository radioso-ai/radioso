import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOperatorMcpDiscoveryRoutes, createOperatorMcpOauthRoutes } from "../../src/modules/operatorMcpAuthorization/routes.js";

const env = {
  SESSION_COOKIE_NAME: "radioso_session", OPERATOR_MCP_ENABLED: true,
  OPERATOR_MCP_ISSUER_URL: "https://app.example", OPERATOR_MCP_RESOURCE_URL: "https://mcp.example/operator/mcp",
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: 5, AUTH_RATE_LIMIT_WINDOW_MS: 60_000,
  RADIOSO_TRUSTED_PROXY_HOPS: 0,
};

const createHarness = (envOverrides: Partial<typeof env> = {}) => {
  const harnessEnv = { ...env, ...envOverrides };
  const service = {
    startAuthorization: vi.fn(async () => ({ transactionId: "tx", consentUrl: "https://app.example/oauth/operator-mcp/consent?transaction=tx" })),
    exchangeAuthorizationCode: vi.fn(async () => ({ accessToken: "access", tokenType: "Bearer", expiresIn: 900, refreshToken: null, scope: "operator:read" })),
    refresh: vi.fn(), revoke: vi.fn(async () => undefined), getTransaction: vi.fn(), decide: vi.fn(),
  };
  const dependencies = {
    env: harnessEnv, operatorMcpAuthorizationService: service, operatorMcpReadiness: Promise.resolve(true),
    operatorMcpClientResolver: { resolve: vi.fn(async () => ({
      recordId: "client", clientId: "https://client.example/cimd", clientVersion: "1",
      metadataSnapshotId: "snapshot", metadataDigest: "digest", applicationType: "web" as const,
      displayName: "Client", redirectUris: ["https://client.example/callback"],
    })) },
    authService: { authenticateSession: vi.fn(async () => ({ userId: "00000000-0000-4000-8000-000000000001", accountId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003" })) },
    accountAccessService: {
      requireActiveMembership: vi.fn(async () => ({ id: "00000000-0000-4000-8000-000000000004" })),
      resolveWorkspaceRole: vi.fn(async () => "member" as const),
    },
    workspaceService: {}, userRepository: {},
    abuseControlService: { enforce: vi.fn(async () => undefined) },
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

  it("builds discovery endpoints without double slashes when the issuer has a trailing slash", async () => {
    const { app } = createHarness({ OPERATOR_MCP_ISSUER_URL: "https://app.example/" });
    const response = await request(app).get("/.well-known/oauth-authorization-server").expect(200);

    expect(response.body).toMatchObject({
      issuer: "https://app.example/",
      authorization_endpoint: "https://app.example/api/v1/operator-mcp/oauth/authorize",
      token_endpoint: "https://app.example/api/v1/operator-mcp/oauth/token",
      revocation_endpoint: "https://app.example/api/v1/operator-mcp/oauth/revoke",
    });
  });

  it("rate-limits authorize before resolving untrusted client metadata", async () => {
    const { app, dependencies } = createHarness();
    dependencies.abuseControlService.enforce.mockRejectedValueOnce(Object.assign(new Error("Too many requests"), { statusCode: 429 }));
    const query = {
      response_type: "code", client_id: "https://client.example/cimd", redirect_uri: "https://client.example/callback",
      scope: "operator:read", state: "state", code_challenge: "a".repeat(43), code_challenge_method: "S256",
      resource: env.OPERATOR_MCP_RESOURCE_URL,
    };

    await request(app).get("/api/v1/operator-mcp/oauth/authorize").query(query).expect(429);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({ scope: "api.operator_mcp_oauth_authorize" }));
    expect(dependencies.operatorMcpClientResolver.resolve).not.toHaveBeenCalled();
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

  it("rejects JSON token requests instead of widening the advertised OAuth contract", async () => {
    const { app, service } = createHarness();

    const response = await request(app).post("/api/v1/operator-mcp/oauth/token").send({
      grant_type: "authorization_code", code: "code", client_id: "client", redirect_uri: "https://client.example/callback",
      code_verifier: "a".repeat(43), resource: env.OPERATOR_MCP_RESOURCE_URL,
    }).expect(400);

    expect(response.body).toEqual({ error: "invalid_request" });
    expect(service.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("does not decide a transaction when credential readiness is unavailable", async () => {
    const { app, dependencies, service } = createHarness();
    dependencies.operatorMcpReadiness = Promise.resolve(false);

    await request(app)
      .post("/api/v1/operator-mcp/oauth/transactions/00000000-0000-4000-8000-000000000099/decision")
      .set("Cookie", "radioso_session=session-token")
      .set("X-Radioso-CSRF", "1")
      .send({ decision: "approve", workspaceId: "00000000-0000-4000-8000-000000000005", approvedToolScopes: ["operator:read"], offlineAccess: false })
      .expect(503);

    expect(service.decide).not.toHaveBeenCalled();
  });
});
