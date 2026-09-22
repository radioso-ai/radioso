import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { signVisitorIdentity } from "../../src/modules/context-variables/public.js";
import type { UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const WORKSPACE_TOKEN_SECRET = "fedcba9876543210fedcba9876543210";

const createWalkInApp = (overrides: {
  abuseControlRepository?: InMemoryAbuseControlRepository;
  envOverrides?: Record<string, unknown>;
  usageLimitPolicy?: UsageLimitPolicy;
} = {}) =>
  createTestApp({
    ...overrides,
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

/** An agent whose operator has opened the credential-free door. */
const openWalkInAgent = async (
  ctx: ReturnType<typeof createWalkInApp>,
  body: Record<string, unknown> = {},
) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const updated = await request(ctx.app)
    .put(`/api/v1/agents/${agent.id}`)
    .set(adminSessionHeaders(session))
    .send({
      agentCardEnabled: true,
      publicAgentAccessEnabled: true,
      publicDescription: "Answers questions about returns.",
      ...body,
    })
    .expect(200);
  return { session, agent, publicId: updated.body.publicId as string };
};

const exchangeWalkIn = (ctx: ReturnType<typeof createWalkInApp>, publicId: string) =>
  request(ctx.app).post("/api/v1/mcp/converse/session").send({ publicId, client: { name: "vitest" } });

describe("MCP converse walk-in access", () => {
  it("issues a session bound to a fresh mcp conversation for a caller with no credential", async () => {
    const ctx = createWalkInApp();
    const { agent, publicId } = await openWalkInAgent(ctx);

    const first = await exchangeWalkIn(ctx, publicId);
    const second = await exchangeWalkIn(ctx, publicId);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      sessionToken: expect.any(String),
      agent: { id: agent.id, name: agent.name },
      conversationId: expect.any(String),
    });
    // FR-031: every walk-in exchange opens its own conversation.
    expect(second.body.conversationId).not.toBe(first.body.conversationId);

    const ask = await request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${first.body.sessionToken}`)
      .send({ message: "Do you take returns?" })
      .expect(200);
    expect(ask.body.conversationId).toBe(first.body.conversationId);

    const conversations = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      agent.workspaceId,
      first.body.conversationId,
      { limit: 10, agentId: agent.id },
    );
    expect(conversations.total).toBe(1);
    expect(conversations.conversations[0]?.sourceChannel).toBe("mcp");
  });

  it("refuses a closed door with the same answer an unknown id gets", async () => {
    const ctx = createWalkInApp();
    const { session, agent, publicId } = await openWalkInAgent(ctx);

    await request(ctx.app)
      .put(`/api/v1/agents/${agent.id}`)
      .set(adminSessionHeaders(session))
      .send({ publicAgentAccessEnabled: false })
      .expect(200);

    const closed = await exchangeWalkIn(ctx, publicId);
    const unknown = await exchangeWalkIn(ctx, "ag_unknownunknownunknow");

    expect(closed.status).toBe(403);
    expect(closed.body).toEqual(unknown.body);
    expect(unknown.status).toBe(403);
  });

  it("refuses a body that names both a launch token and a public id", async () => {
    const ctx = createWalkInApp();
    const { publicId } = await openWalkInAgent(ctx);

    const response = await request(ctx.app)
      .post("/api/v1/mcp/converse/session")
      .send({ publicId, launchToken: "radioso_mcp_whatever" });

    expect(response.status).toBe(400);
  });

  it("throttles the per-agent walk-in budget with Retry-After and RateLimit headers", async () => {
    const ctx = createWalkInApp({ abuseControlRepository: new InMemoryAbuseControlRepository() });
    const { publicId } = await openWalkInAgent(ctx, { walkInConversationsPerHour: 1 });

    const admitted = await exchangeWalkIn(ctx, publicId);
    const throttled = await exchangeWalkIn(ctx, publicId);

    expect(admitted.status).toBe(201);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttled.headers["ratelimit-limit"]).toBe("1");
    expect(throttled.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(throttled.headers["ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("revokes a live walk-in session when the public id rotates", async () => {
    const ctx = createWalkInApp();
    const { session, agent, publicId } = await openWalkInAgent(ctx);
    const exchange = await exchangeWalkIn(ctx, publicId);
    expect(exchange.status).toBe(201);

    const rotated = await request(ctx.app)
      .post(`/api/v1/agents/${agent.id}/public-id/rotate`)
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(rotated.body.publicId).not.toBe(publicId);

    const afterRotation = await request(ctx.app)
      .post("/api/v1/mcp/converse/session/validate")
      .send({ sessionToken: exchange.body.sessionToken });

    expect(afterRotation.status).toBe(403);
    expect(afterRotation.body.error.details).toMatchObject({ code: "walk_in_revoked" });
  });

  it("verifies a signed identity bound to the converse session and ignores a mismatched one", async () => {
    const ctx = createWalkInApp();
    const { agent, publicId } = await openWalkInAgent(ctx);

    const verified = await exchangeWalkIn(ctx, publicId).expect(201);
    const identity = (sessionId: string) => signVisitorIdentity(
      WORKSPACE_TOKEN_SECRET,
      agent.workspaceId,
      agent.id,
      {
        customerId: "customer-77",
        sessionId,
        origin: "https://caller.example",
        issuedAt: Date.now(),
        nonce: randomUUID(),
      },
    );

    await request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${verified.body.sessionToken}`)
      .send({ message: "Where is my order?", signedIdentity: identity(verified.body.conversationId) })
      .expect(200);

    const mismatched = await exchangeWalkIn(ctx, publicId).expect(201);
    await request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${mismatched.body.sessionToken}`)
      .send({ message: "Where is my order?", signedIdentity: identity(randomUUID()) })
      .expect(200);

    const verifiedConversation = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      agent.workspaceId,
      verified.body.conversationId,
      { limit: 1, agentId: agent.id },
    );
    const anonymousConversation = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      agent.workspaceId,
      mismatched.body.conversationId,
      { limit: 1, agentId: agent.id },
    );
    expect(verifiedConversation.conversations[0]?.verifiedCustomerId).toBe("customer-77");
    // A binding that does not match leaves the turn anonymous, with no error.
    expect(anonymousConversation.conversations[0]?.verifiedCustomerId ?? null).toBeNull();
  });

  it("meters a walk-in turn as a conversation reply like every other channel", async () => {
    const reserveAnswer = vi.fn().mockResolvedValue({
      commit: async () => undefined,
      release: async () => undefined,
    });
    const usageLimitPolicy = {
      reserveAnswer,
      reserveDocument: vi.fn(),
      reserveIndexedStorage: vi.fn(),
      reserveMonthlyIndexedContent: vi.fn(),
    } as unknown as UsageLimitPolicy;
    const ctx = createWalkInApp({ usageLimitPolicy });
    const { publicId } = await openWalkInAgent(ctx);

    const exchange = await exchangeWalkIn(ctx, publicId).expect(201);
    await request(ctx.app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${exchange.body.sessionToken}`)
      .send({ message: "Hello" })
      .expect(200);

    expect(reserveAnswer).toHaveBeenCalledWith(expect.objectContaining({
      usage: "conversation_reply",
      surface: "mcp",
    }));
  });
});
