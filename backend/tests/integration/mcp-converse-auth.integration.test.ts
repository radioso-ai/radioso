import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const createAppWithMcpConverse = () =>
  createTestApp({
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

describe("MCP converse auth separation", () => {
  it("rejects workspace API bearer tokens on the converse path", async () => {
    const { app } = createAppWithMcpConverse();
    const { token } = await issueTestToken(app);

    const response = await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Hello" });

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: "unauthorized",
    });
  });

  it("rejects embed and public-link launch tokens for converse exchange", async () => {
    const ctx = createAppWithMcpConverse();
    const session = await issueTestSession(ctx.app);
    const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
    const common = {
      agentId: agent.id,
      workspaceId: session.workspaceId,
      principalKind: "public-launch" as const,
      originConstraint: { mode: "allow-all" as const, origins: [] as [] },
    };
    const embed = await ctx.dependencies.accessGrantService.issueGrant({ ...common, channel: "embed" });
    const publicLink = await ctx.dependencies.accessGrantService.issueGrant({ ...common, channel: "public-link" });

    for (const launchToken of [embed.token, publicLink.token]) {
      const response = await request(ctx.app)
        .post("/api/v1/mcp/converse/session")
        .send({ launchToken });

      expect(response.status).toBe(403);
    }
  });

  it("does not resolve mcp-converse grants through the public launch resolver", async () => {
    const ctx = createAppWithMcpConverse();
    const session = await issueTestSession(ctx.app);
    const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
    const { token } = await ctx.dependencies.accessGrantService.issueGrant({
      agentId: agent.id,
      workspaceId: session.workspaceId,
      principalKind: "public-launch",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    await expect(ctx.dependencies.accessGrantService.resolvePublicLaunchGrant(token)).resolves.toBeNull();
  });
});
