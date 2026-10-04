import request from "supertest";
import { describe, expect, it } from "vitest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const createConverseApp = () =>
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

type ConverseApp = ReturnType<typeof createConverseApp>;

/** A credential-bound session that has already run one turn, so it has a conversation. */
const openGrantSession = async (ctx: ConverseApp) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const grantSecret = await ctx.dependencies.accessGrantService.issueGrant({
    agentId: agent.id,
    workspaceId: session.workspaceId,
    principalKind: "agent-api",
    channel: "mcp-converse",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const exchange = await request(ctx.app)
    .post("/api/v1/mcp/converse/session")
    .send({ launchToken: grantSecret.token })
    .expect(201);
  return {
    session,
    agent,
    grantId: grantSecret.grant.id,
    sessionToken: exchange.body.sessionToken as string,
    publicSessionId: exchange.body.conversationId as string,
  };
};

const openWalkInSession = async (ctx: ConverseApp) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const updated = await request(ctx.app)
    .put(`/api/v1/agents/${agent.id}`)
    .set(adminSessionHeaders(session))
    .send({ agentCardEnabled: true, publicAgentAccessEnabled: true, publicDescription: "Answers returns questions." })
    .expect(200);
  const exchange = await request(ctx.app)
    .post("/api/v1/mcp/converse/session")
    .send({ publicId: updated.body.publicId })
    .expect(201);
  return {
    sessionToken: exchange.body.sessionToken as string,
    publicSessionId: exchange.body.conversationId as string,
  };
};

const ask = (ctx: ConverseApp, sessionToken: string, message: string) =>
  request(ctx.app)
    .post("/api/v1/mcp/converse/ask")
    .set("Authorization", `Bearer ${sessionToken}`)
    .send({ message })
    .expect(200);

const readUpdates = (
  ctx: ConverseApp,
  sessionToken: string,
  query: { cursor?: string; waitMs?: number } = {},
) =>
  request(ctx.app)
    .get("/api/v1/mcp/converse/messages")
    .query(query)
    .set("Authorization", `Bearer ${sessionToken}`);

/** Takes the conversation over as the operator, then answers on it. */
const humanReply = async (
  ctx: ConverseApp,
  session: Awaited<ReturnType<typeof issueTestSession>>,
  conversationId: string,
  message: string,
) => {
  const takeover = await request(ctx.app)
    .post(`/api/v1/conversations/${conversationId}/takeover`)
    .set(adminSessionHeaders(session))
    .send({ reason: "Needs a person" })
    .expect(200);
  return request(ctx.app)
    .post(`/api/v1/conversations/${conversationId}/reply`)
    .set(adminSessionHeaders(session))
    .send({ message, expectedVersion: takeover.body.ownership.version })
    .expect(201);
};

/** The conversation row behind a converse session's public session id. */
const conversationIdFor = async (ctx: ConverseApp, workspaceId: string, publicSessionId: string) => {
  const page = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
    workspaceId,
    publicSessionId,
    { limit: 1 },
  );
  const conversationId = page.conversations[0]?.id;
  if (!conversationId) throw new Error("converse session has no conversation");
  return conversationId;
};

describe("MCP converse conversation updates", () => {
  it("returns a human's reply to the caller that handed off, with author human (SC-006)", async () => {
    const ctx = createConverseApp();
    const { session, sessionToken, publicSessionId } = await openGrantSession(ctx);
    await ask(ctx, sessionToken, "I need a refund.");

    const caughtUp = await readUpdates(ctx, sessionToken).expect(200);
    expect(caughtUp.body.messages.map((message: { author: string }) => message.author)).toEqual(["agent", "agent"]);
    const cursor = caughtUp.body.cursor as string;
    expect(cursor).toEqual(expect.any(String));

    const conversationId = await conversationIdFor(ctx, session.workspaceId, publicSessionId);
    await humanReply(ctx, session, conversationId, "I have refunded the order.");

    // The reply is already in place, so even a long poll answers on its first read.
    const resumed = await readUpdates(ctx, sessionToken, { cursor, waitMs: 2_000 }).expect(200);

    expect(resumed.body.messages).toHaveLength(1);
    expect(resumed.body.messages[0]).toMatchObject({
      author: "human",
      text: "I have refunded the order.",
    });
    expect(resumed.body.ownership).toEqual({ state: "human_owned" });
    expect(resumed.body.cursor).not.toBe(cursor);
  });

  it("returns immediately with an empty list when waitMs is 0 and nothing is new (AS-2)", async () => {
    const ctx = createConverseApp();
    const { sessionToken } = await openGrantSession(ctx);
    await ask(ctx, sessionToken, "Hello");

    const caughtUp = await readUpdates(ctx, sessionToken).expect(200);
    const startedAt = Date.now();
    const empty = await readUpdates(ctx, sessionToken, { cursor: caughtUp.body.cursor, waitMs: 0 }).expect(200);

    expect(empty.body.messages).toEqual([]);
    expect(empty.body.ownership).toEqual({ state: "ai_owned" });
    expect(empty.body.cursor).toBe(caughtUp.body.cursor);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("returns an empty list at the deadline rather than an error (AS-2)", async () => {
    const ctx = createConverseApp();
    const { sessionToken } = await openGrantSession(ctx);
    await ask(ctx, sessionToken, "Hello");
    const caughtUp = await readUpdates(ctx, sessionToken).expect(200);

    // A deadline short enough to keep the suite fast; the wait mechanism is the same
    // one a 25 000 ms call uses.
    const timedOut = await readUpdates(ctx, sessionToken, { cursor: caughtUp.body.cursor, waitMs: 150 }).expect(200);

    expect(timedOut.body.messages).toEqual([]);
  });

  it("wakes a parked caller when the reply lands while it waits", async () => {
    const ctx = createConverseApp();
    const { session, sessionToken, publicSessionId } = await openGrantSession(ctx);
    await ask(ctx, sessionToken, "Can a person help?");
    const caughtUp = await readUpdates(ctx, sessionToken).expect(200);
    const conversationId = await conversationIdFor(ctx, session.workspaceId, publicSessionId);

    const parked = readUpdates(ctx, sessionToken, { cursor: caughtUp.body.cursor, waitMs: 5_000 });
    await humanReply(ctx, session, conversationId, "On it.");

    const resumed = await parked.expect(200);
    expect(resumed.body.messages).toHaveLength(1);
    expect(resumed.body.messages[0]).toMatchObject({ author: "human", text: "On it." });
  });

  it("refuses the read when the session's credential is revoked (AS-3)", async () => {
    const ctx = createConverseApp();
    const { grantId, sessionToken } = await openGrantSession(ctx);
    await ask(ctx, sessionToken, "Hello");

    await ctx.dependencies.accessGrantService.revokeGrant({ grantId });

    const refused = await readUpdates(ctx, sessionToken);
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toMatchObject({ code: "grant_revoked" });
  });

  it("refuses a read with no converse session at all", async () => {
    const ctx = createConverseApp();
    const anonymous = await request(ctx.app).get("/api/v1/mcp/converse/messages");
    expect(anonymous.status).toBe(401);
  });

  it("refuses a waitMs beyond the ceiling", async () => {
    const ctx = createConverseApp();
    const { sessionToken } = await openGrantSession(ctx);

    const refused = await readUpdates(ctx, sessionToken, { waitMs: 25_001 });
    expect(refused.status).toBe(400);
  });

  it("lets a walk-in session read its own updates, credential or not", async () => {
    const ctx = createConverseApp();
    const { sessionToken } = await openWalkInSession(ctx);
    await ask(ctx, sessionToken, "Do you take returns?");

    const updates = await readUpdates(ctx, sessionToken).expect(200);

    expect(updates.body.messages).toHaveLength(2);
    expect(updates.body.messages.map((message: { author: string }) => message.author)).toEqual(["agent", "agent"]);
    expect(updates.body.messages[0].text).toBe("Do you take returns?");
    expect(updates.body.ownership).toEqual({ state: "ai_owned" });
  });

  it("answers a session that has not run a turn yet with an empty page rather than a 404", async () => {
    const ctx = createConverseApp();
    const { sessionToken } = await openGrantSession(ctx);

    const updates = await readUpdates(ctx, sessionToken, { waitMs: 0 }).expect(200);

    expect(updates.body).toEqual({
      messages: [],
      cursor: null,
      ownership: { state: "ai_owned" },
    });
  });
});
