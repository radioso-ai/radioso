import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const createAppWithMcpConverse = () =>
  createTestApp({
    chatGateway: {
      async answer(input) {
        return `agent:${input.query}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
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
  return { agent, launchToken: token, workspaceId: session.workspaceId };
};

describe("MCP converse session and ask flow", () => {
  it("exchanges a converse grant and continues two ask_agent turns in one session", async () => {
    const ctx = createAppWithMcpConverse();
    const { agent, launchToken } = await issueConverseGrant(ctx);

    const exchange = await request(ctx.app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken, client: { name: "vitest" } });

    expect(exchange.status).toBe(201);
    expect(exchange.body).toMatchObject({
      sessionToken: expect.any(String),
      agent: { id: agent.id, name: agent.name },
      conversationId: expect.any(String),
      expiresAt: expect.any(String),
    });

    const first = await request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken}`)
      .send({ message: "first" });
    const second = await request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken}`)
      .send({ message: "second" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The converse ask runs the bound agent's real turn loop (AssistantChatService),
    // so the answer text is whatever that pipeline produces (with no seeded documents
    // it is the agent's no-evidence response). The US1 guarantee under test is that
    // both turns run and share one continuing conversation, not a specific LLM string.
    expect(first.body.conversationId).toBe(exchange.body.conversationId);
    expect(second.body.conversationId).toBe(exchange.body.conversationId);
    expect(typeof first.body.answer.text).toBe("string");
    expect(first.body.answer.text.length).toBeGreaterThan(0);
    expect(typeof second.body.answer.text).toBe("string");
    expect(second.body.answer.text.length).toBeGreaterThan(0);

    const conversations = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      agent.workspaceId,
      exchange.body.conversationId,
      { limit: 10, agentId: agent.id },
    );
    expect(conversations.total).toBe(1);
  });
});
