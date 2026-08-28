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

const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  id: grantId,
  agentId,
  workspaceId,
  label: "Desktop client",
  principalKind: "public-launch",
  role: "agent",
  channel: "mcp-converse",
  tokenPrefix: "rdso_abc",
  tokenHash: "secret-hash",
  encryptedToken: "encrypted-secret",
  originConstraint: { mode: "allow-all", origins: [] },
  enabled: true,
  expiresAt: null,
  createdAt: new Date("2026-06-28T10:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
  ...overrides,
});

const createDependencies = (
  overrides: Partial<AppDependencies> = {},
): AppDependencies => ({
  env: { SESSION_COOKIE_NAME: "radioso_session" },
  authService: {
    authenticateApiToken: vi.fn().mockResolvedValue({
      accountId: "account-1",
      workspaceId,
      principal: { type: "workspace_api_token", role: "admin", tokenId: "token-1", workspaceId },
    }),
  },
  accountAccessService: {
    requirePermission: vi.fn().mockResolvedValue(undefined),
  },
  workspaceSessionService: {},
  agentRepository: {
    findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: agentId, workspaceId }),
  },
  accessGrantService: {
    issueGrant: vi.fn().mockResolvedValue({ grant: grant(), token: "plain-issued-token" }),
    listAgentGrants: vi.fn().mockResolvedValue([
      grant(),
      grant({ id: "55555555-5555-4555-8555-555555555555", channel: "public-link" }),
    ]),
    findGrantById: vi.fn().mockResolvedValue(grant()),
    rotateGrant: vi.fn().mockResolvedValue({ grant: grant({ tokenPrefix: "rdso_rot" }), token: "plain-rotated-token" }),
    revokeGrant: vi.fn().mockResolvedValue(grant({ revokedAt: new Date("2026-06-28T11:00:00.000Z") })),
  },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
    const code = (error as { code?: string })?.code ?? "internal_error";
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(statusCode).json({ code, message });
  });
  return app;
};

describe("agent MCP converse grant routes", () => {
  it("requires agent management permission before issuing a grant", async () => {
    const dependencies = createDependencies({
      accountAccessService: {
        requirePermission: vi.fn().mockRejectedValue({
          statusCode: 403,
          code: "forbidden",
          message: "You do not have permission to perform this action",
        }),
      } as unknown as AppDependencies["accountAccessService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/mcp-converse-grants`)
      .set("Authorization", "Bearer token")
      .send({ label: "Desktop client" })
      .expect(403);

    expect(dependencies.accessGrantService.issueGrant).not.toHaveBeenCalled();
  });

  it("issues a public-launch MCP converse grant and returns the token only once", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/mcp-converse-grants`)
      .set("Authorization", "Bearer token")
      .send({ label: "Desktop client" })
      .expect(201);

    expect(dependencies.accessGrantService.issueGrant).toHaveBeenCalledWith({
      agentId,
      workspaceId,
      accountId: "account-1",
      principalKind: "public-launch",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      label: "Desktop client",
    });
    expect(response.body).toEqual({
      grant: {
        id: grantId,
        label: "Desktop client",
        tokenPrefix: "rdso_abc",
        createdAt: "2026-06-28T10:00:00.000Z",
      },
      token: "plain-issued-token",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-hash");
    expect(JSON.stringify(response.body)).not.toContain("encrypted-secret");
  });

  it("lists only MCP converse metadata for the requested agent", async () => {
    const response = await request(createApp())
      .get(`/api/v1/agents/${agentId}/mcp-converse-grants`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(response.body).toEqual({
      grants: [{
        id: grantId,
        label: "Desktop client",
        tokenPrefix: "rdso_abc",
        enabled: true,
        createdAt: "2026-06-28T10:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      }],
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-hash");
    expect(JSON.stringify(response.body)).not.toContain("encrypted-secret");
  });

  it("rejects rotation for grants outside the requested agent or channel", async () => {
    const dependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        findGrantById: vi.fn().mockResolvedValue(grant({ agentId: otherAgentId })),
      } as unknown as AppDependencies["accessGrantService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/mcp-converse-grants/${grantId}/rotate`)
      .set("Authorization", "Bearer token")
      .send()
      .expect(404);

    expect(dependencies.accessGrantService.rotateGrant).not.toHaveBeenCalled();
  });

  it("rotates a matching MCP converse grant and returns the new token once", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/mcp-converse-grants/${grantId}/rotate`)
      .set("Authorization", "Bearer token")
      .send()
      .expect(200);

    expect(dependencies.accessGrantService.rotateGrant).toHaveBeenCalledWith({
      grantId,
      accountId: "account-1",
      reason: "mcp_converse_grant_rotate",
    });
    expect(response.body.token).toBe("plain-rotated-token");
    expect(response.body.grant).toMatchObject({ id: grantId, tokenPrefix: "rdso_rot" });
    expect(JSON.stringify(response.body)).not.toContain("secret-hash");
    expect(JSON.stringify(response.body)).not.toContain("encrypted-secret");
  });

  it("revokes only matching MCP converse grants", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .delete(`/api/v1/agents/${agentId}/mcp-converse-grants/${grantId}`)
      .set("Authorization", "Bearer token")
      .expect(204);

    expect(dependencies.accessGrantService.revokeGrant).toHaveBeenCalledWith({
      grantId,
      accountId: "account-1",
      reason: "mcp_converse_grant_revoke",
    });
  });
});
