import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { AccessGrant } from "../../src/modules/accessGrants/domain.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const otherAgentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const grantId = "44444444-4444-4444-8444-444444444444";
const expiresAt = new Date("2027-06-28T10:00:00.000Z");

const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  id: grantId,
  agentId,
  workspaceId,
  label: "Desktop client",
  principalKind: "agent-api",
  role: "agent",
  channel: "mcp-converse",
  tokenPrefix: "rdso_abc",
  tokenHash: "secret-hash",
  encryptedToken: null,
  originConstraint: { mode: "allow-all", origins: [] },
  enabled: true,
  expiresAt,
  createdAt: new Date("2026-06-28T10:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
  ...overrides,
});

const createDependencies = (overrides: Partial<AppDependencies> = {}): AppDependencies => ({
  env: { SESSION_COOKIE_NAME: "radioso_session" },
  authService: {
    authenticateSession: vi.fn().mockResolvedValue({ accountId: "account-1", userId: "user-1", sessionId: "session-1" }),
  },
  accountAccessService: {
    requireActiveMembership: vi.fn().mockResolvedValue(undefined),
    requirePermission: vi.fn().mockResolvedValue(undefined),
  },
  workspaceSessionService: {
    resolve: vi.fn().mockResolvedValue({ accountId: "account-1", workspaceId }),
  },
  agentRepository: {
    findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: agentId, workspaceId }),
  },
  accessGrantService: {
    issueGrant: vi.fn().mockResolvedValue({ grant: grant(), token: "plain-issued-token" }),
    listAgentGrants: vi.fn(async (_agentId: string, params: { channel?: string } = {}) => ({
      grants: [
        grant(),
        grant({ id: "55555555-5555-4555-8555-555555555555", channel: "agent-api" }),
        grant({ id: "66666666-6666-4666-8666-666666666666", channel: "public-link", principalKind: "public-launch" }),
      ].filter((item) => !params.channel || item.channel === params.channel),
      nextCursor: null,
    })),
    findGrantById: vi.fn().mockResolvedValue(grant()),
    rotateGrant: vi.fn().mockResolvedValue({ grant: grant({ tokenPrefix: "rdso_rot" }), token: "plain-rotated-token" }),
    revokeGrant: vi.fn().mockResolvedValue(grant({ revokedAt: new Date("2026-06-28T11:00:00.000Z") })),
  },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = { radioso_session: "session" };
    next();
  });
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
    const code = (error as { code?: string })?.code ?? "internal_error";
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(statusCode).json({ code, message });
  });
  return app;
};

describe("agent channel credential routes", () => {
  it("requires the API-access CSRF header for every channel-credential mutation", async () => {
    const dependencies = createDependencies();
    const app = createApp(dependencies);

    await request(app)
      .post(`/api/v1/agents/${agentId}/channel-credentials`)
      .send({ audience: "mcp", label: "Desktop client", expiresAt: expiresAt.toISOString() })
      .expect(403);
    await request(app)
      .post(`/api/v1/agents/${agentId}/channel-credentials/${grantId}/rotate`)
      .send()
      .expect(403);
    await request(app)
      .post(`/api/v1/agents/${agentId}/channel-credentials/${grantId}/revoke`)
      .send()
      .expect(403);

    expect(dependencies.accessGrantService.issueGrant).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.rotateGrant).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.revokeGrant).not.toHaveBeenCalled();
  });

  it("requires agent management permission before issuing a credential", async () => {
    const dependencies = createDependencies({
      accountAccessService: {
        requireActiveMembership: vi.fn().mockResolvedValue(undefined),
        requirePermission: vi.fn().mockRejectedValue({ statusCode: 403, code: "forbidden", message: "Forbidden" }),
      } as unknown as AppDependencies["accountAccessService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/channel-credentials`)
      .set("X-Radioso-CSRF", "1")
      .send({ audience: "mcp", label: "Desktop client", expiresAt: expiresAt.toISOString() })
      .expect(403);

    expect(dependencies.accessGrantService.issueGrant).not.toHaveBeenCalled();
  });

  it("issues a role-free MCP credential and returns the secret only once", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/channel-credentials`)
      .set("X-Radioso-CSRF", "1")
      .send({ audience: "mcp", label: "Desktop client", expiresAt: expiresAt.toISOString() })
      .expect(201);

    expect(dependencies.accessGrantService.issueGrant).toHaveBeenCalledWith({
      agentId,
      workspaceId,
      accountId: "account-1",
      actor: { kind: "user", id: "user-1" },
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      label: "Desktop client",
      expiresAt,
    });
    expect(response.body).toEqual({
      credential: {
        id: grantId,
        audience: "mcp",
        label: "Desktop client",
        prefix: "rdso_abc",
        status: "active",
        createdAt: "2026-06-28T10:00:00.000Z",
        expiresAt: "2027-06-28T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
      secret: "plain-issued-token",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-hash");
  });

  it("lists only the requested audience for the requested agent", async () => {
    const response = await request(createApp())
      .get(`/api/v1/agents/${agentId}/channel-credentials?audience=rest`)
      .expect(200);

    expect(response.body.credentials).toHaveLength(1);
    expect(response.body.credentials[0]).toMatchObject({ audience: "rest" });
    expect(response.body.credentials[0]).not.toHaveProperty("role");
    expect(response.body.nextCursor).toBeNull();
  });

  it("passes bounded pagination and agent scope to the credential service", async () => {
    const dependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        listAgentGrants: vi.fn().mockResolvedValue({ grants: [], nextCursor: { createdAt: expiresAt, id: grantId } }),
      } as unknown as AppDependencies["accessGrantService"],
    });
    const cursor = Buffer.from(JSON.stringify({ createdAt: expiresAt.toISOString(), id: grantId }), "utf8").toString("base64url");

    const response = await request(createApp(dependencies))
      .get(`/api/v1/agents/${agentId}/channel-credentials?audience=rest&limit=25&cursor=${cursor}`)
      .expect(200);

    expect(response.body.nextCursor).toEqual(expect.any(String));
    expect(dependencies.accessGrantService.listAgentGrants).toHaveBeenCalledWith(agentId, {
      workspaceId,
      principalKind: "agent-api",
      channel: "agent-api",
      limit: 25,
      cursor: { createdAt: expiresAt, id: grantId },
    });
  });

  it("rejects rotation for credentials outside the requested agent or audience", async () => {
    const dependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        findGrantById: vi.fn().mockResolvedValue(grant({ agentId: otherAgentId })),
      } as unknown as AppDependencies["accessGrantService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/channel-credentials/${grantId}/rotate`)
      .set("X-Radioso-CSRF", "1")
      .send()
      .expect(404);

    expect(dependencies.accessGrantService.rotateGrant).not.toHaveBeenCalled();
  });

  it("rotates and revokes a matching credential", async () => {
    const dependencies = createDependencies();

    const rotated = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/channel-credentials/${grantId}/rotate`)
      .set("X-Radioso-CSRF", "1")
      .send()
      .expect(200);
    expect(rotated.body.secret).toBe("plain-rotated-token");
    expect(dependencies.accessGrantService.rotateGrant).toHaveBeenCalledWith({
      grantId,
      accountId: "account-1",
      actor: { kind: "user", id: "user-1" },
      reason: "agent_channel_credential_rotate",
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/channel-credentials/${grantId}/revoke`)
      .set("X-Radioso-CSRF", "1")
      .send()
      .expect(204);
    expect(dependencies.accessGrantService.revokeGrant).toHaveBeenCalledWith({
      grantId,
      accountId: "account-1",
      actor: { kind: "user", id: "user-1" },
      reason: "agent_channel_credential_revoke",
    });
  });
});
