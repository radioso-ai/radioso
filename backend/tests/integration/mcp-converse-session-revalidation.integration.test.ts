import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const createAppWithMcpConverse = () =>
  createTestApp({
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

const exchangeSession = async (ctx: ReturnType<typeof createAppWithMcpConverse>) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const grantSecret = await ctx.dependencies.accessGrantService.issueGrant({
    agentId: agent.id,
    workspaceId: session.workspaceId,
    principalKind: "public-launch",
    channel: "mcp-converse",
    originConstraint: { mode: "allow-all", origins: [] },
  });
  const exchange = await request(ctx.app)
    .post("/api/v1/mcp/converse/session")
    .send({ launchToken: grantSecret.token });
  expect(exchange.status).toBe(201);
  return { grantId: grantSecret.grant.id, sessionToken: exchange.body.sessionToken };
};

describe("MCP converse per-request grant revalidation", () => {
  it("invalidates the next request after grant revocation", async () => {
    const ctx = createAppWithMcpConverse();
    const { grantId, sessionToken } = await exchangeSession(ctx);

    await ctx.dependencies.accessGrantService.revokeGrant({ grantId });

    const response = await request(ctx.app)
      .post("/api/v1/mcp/converse/session/validate")
      .send({ sessionToken });

    expect(response.status).toBe(403);
    expect(response.body.error.details).toMatchObject({ code: "grant_revoked" });
  });

  it("invalidates the next request after grant disable, expiry, or rotation", async () => {
    const ctx = createAppWithMcpConverse();

    const disabled = await exchangeSession(ctx);
    await ctx.dependencies.accessGrantService.updateGrantConstraints({ grantId: disabled.grantId, enabled: false });
    expect((await request(ctx.app).post("/api/v1/mcp/converse/session/validate").send({ sessionToken: disabled.sessionToken })).status).toBe(403);

    const expired = await exchangeSession(ctx);
    const expiredGrant = await ctx.repositories.accessGrantRepository.findById(expired.grantId);
    if (!expiredGrant) throw new Error("missing grant");
    expiredGrant.expiresAt = new Date(Date.now() - 1000);
    expect((await request(ctx.app).post("/api/v1/mcp/converse/session/validate").send({ sessionToken: expired.sessionToken })).status).toBe(403);

    const rotated = await exchangeSession(ctx);
    await ctx.dependencies.accessGrantService.rotateGrant({ grantId: rotated.grantId });
    const response = await request(ctx.app)
      .post("/api/v1/mcp/converse/session/validate")
      .send({ sessionToken: rotated.sessionToken });
    expect(response.status).toBe(403);
    expect(response.body.error.details).toMatchObject({ code: "grant_rotated" });
  });
});
