import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import type { RerankGatewayInput } from "../../src/modules/retrieval/services/rerankService.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const createAppWithMcpConverse = () =>
  createTestApp({
    chatGateway: {
      async answer(input) {
        return `grounded:${input.query}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
    },
    rerankGateway: {
      rerank: vi.fn(async (input: RerankGatewayInput) =>
        input.contexts.map((context, index: number) => ({
          chunkId: context.chunkId,
          relevanceScore: 1 - index * 0.01,
        })),
      ),
    },
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

const issueConverseGrant = async (ctx: ReturnType<typeof createAppWithMcpConverse>) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const { token } = await ctx.dependencies.accessGrantService.issueGrant({
    agentId: agent.id,
    workspaceId: session.workspaceId,
    principalKind: "public-launch",
    channel: "mcp-converse",
    originConstraint: { mode: "allow-all", origins: [] },
  });
  const exchange = await request(ctx.app)
    .post("/api/v1/mcp/converse/session")
    .send({ launchToken: token, client: { name: "vitest" } });
  expect(exchange.status).toBe(201);
  return { agent, sessionToken: exchange.body.sessionToken as string, workspaceId: session.workspaceId };
};

describe("MCP converse grounded answer", () => {
  it("uses the bound agent retrieval settings and citation policy", async () => {
    const ctx = createAppWithMcpConverse();
    const { agent, sessionToken, workspaceId } = await issueConverseGrant(ctx);

    // Keep the agent's default source scope (validateSourceScope rejects scoping to
    // manually-added docs in a workspace that has none). This test asserts the grounded
    // answer honours the agent's retrieval skill settings and citation policy.
    await ctx.dependencies.agentService.update(workspaceId, agent.id, {
      citationDisplayEnabled: false,
      skillSettings: {
        "retrieval.answer": {
          queryRewriteEnabled: true,
          rerankEnabled: true,
          vectorTopK: 12,
          rerankTopK: 4,
        },
      },
    });

    const response = await request(ctx.app)
      .post("/api/v1/mcp/converse/grounded-answer")
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ query: "Which policy applies?", maxResults: 4 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      answer: expect.any(String),
      citations: [],
      retrieval: { agentScoped: true },
    });
  });
});
