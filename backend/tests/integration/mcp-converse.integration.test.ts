import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createAppWithMcpConverse = (overrides: {
  chatGateway?: ChatGateway;
  turnRouter?: TurnRouter;
} = {}) =>
  createTestApp({
    chatGateway: overrides.chatGateway ?? {
      async answer(input) {
        return `agent:${input.query}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
    },
    turnRouter: overrides.turnRouter,
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
    principalKind: "agent-api",
    channel: "mcp-converse",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 60_000),
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

  it("binds concurrent first asks to one conversation and persists only the latest answer", async () => {
    const firstRoutingStarted = deferred();
    const releaseFirstRouting = deferred();
    const turnRouter: TurnRouter = {
      async classify(input) {
        if (input.query === "first") {
          firstRoutingStarted.resolve();
          await releaseFirstRouting.promise;
        }
        return { route: "direct", framing: { isIdentityQuestion: false } };
      },
    };
    const chatGateway: ChatGateway = {
      async answer(input) {
        const earlierUsers = input.history
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join(" | ");
        return `latest=${input.query}; history=${earlierUsers}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const ctx = createAppWithMcpConverse({ chatGateway, turnRouter });
    const latestAnswerStarted = deferred();
    const answer = ctx.dependencies.assistantChatService.answer.bind(ctx.dependencies.assistantChatService);
    vi.spyOn(ctx.dependencies.assistantChatService, "answer").mockImplementation((input) => {
      const result = answer(input);
      if (input.message === "latest") {
        latestAnswerStarted.resolve();
      }
      return result;
    });
    const { agent, launchToken } = await issueConverseGrant(ctx);
    const exchange = await request(ctx.app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken, client: { name: "vitest" } });

    const first = request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken}`)
      .send({ message: "first" })
      .then((response) => response);
    await firstRoutingStarted.promise;
    const latest = request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken}`)
      .send({ message: "latest" })
      .then((response) => response);
    await latestAnswerStarted.promise;
    releaseFirstRouting.resolve();

    const responses = await Promise.all([first, latest]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const conversations = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      agent.workspaceId,
      exchange.body.conversationId,
      { limit: 10, agentId: agent.id },
    );
    expect(conversations.total).toBe(1);
    const conversation = conversations.conversations[0];
    expect(conversation).toBeDefined();
    const messages = await ctx.repositories.messageRepository.listByConversationId(
      agent.workspaceId,
      conversation.id,
    );
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest=latest; history=first" },
    ]);
  });
});
