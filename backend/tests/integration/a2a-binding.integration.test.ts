import request from "supertest";
import { describe, expect, it } from "vitest";

import { A2A_CONVERSE_EXTENSION_URI } from "../../src/shared/domain/a2aConverseExtension.js";
import {
  conversationIdForContext,
  createA2aTestApp,
  issueConverseGrant,
  openA2aAgent,
  rpc,
  sendText,
  supportIntakeDraft,
} from "../support/a2aTestApp.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";
import { adminSessionHeaders } from "../support/testApp.js";

describe("A2A binding: contexts and plain answers (US1)", () => {
  it("answers a walk-in SendMessage with a Message and a context id, then continues the same conversation", async () => {
    const ctx = createA2aTestApp();
    const { agent, publicId } = await openA2aAgent(ctx);

    const first = await sendText(ctx, publicId, "Do you take returns?").expect(200);

    expect(first.body).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      result: {
        message: {
          messageId: expect.any(String),
          contextId: expect.any(String),
          role: "ROLE_AGENT",
          parts: [{ text: "agent:Do you take returns?" }],
        },
      },
    });
    const contextId = first.body.result.message.contextId as string;
    const conversationId = await conversationIdForContext(ctx, contextId);
    const conversation = await ctx.repositories.conversationRepository.findByIdAndWorkspaceId(conversationId, agent.workspaceId);
    expect(conversation?.sourceChannel).toBe("a2a");
    // A plain answer leaves no task behind.
    expect(ctx.stores.tasks.tasks.size).toBe(0);

    const second = await sendText(ctx, publicId, "And exchanges?", { contextId }).expect(200);
    expect(second.body.result.message).toMatchObject({ contextId, parts: [{ text: "agent:And exchanges?" }] });
    expect(await conversationIdForContext(ctx, second.body.result.message.contextId)).toBe(conversationId);
    const messages = await ctx.repositories.messageRepository.listByConversationId(agent.workspaceId, conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "Do you take returns?",
      "agent:Do you take returns?",
      "And exchanges?",
      "agent:And exchanges?",
    ]);
  });

  it("opens a fresh conversation for each new context", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await openA2aAgent(ctx);

    const first = await sendText(ctx, publicId, "Hello").expect(200);
    const second = await sendText(ctx, publicId, "Hello").expect(200);

    expect(await conversationIdForContext(ctx, first.body.result.message.contextId))
      .not.toBe(await conversationIdForContext(ctx, second.body.result.message.contextId));
  });
});

describe("A2A binding: version, extension, and the agent in the path", () => {
  it("answers -32009 when A2A-Version is absent, which means 0.3, or names another version", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await openA2aAgent(ctx);

    for (const version of [null, "0.3"]) {
      const refused = await sendText(ctx, publicId, "Hello", {}, { version }).expect(200);
      expect(refused.body).toMatchObject({ id: "req-1", error: { code: -32009, data: [{ reason: "VERSION_NOT_SUPPORTED" }] } });
    }
    expect(ctx.stores.tasks.tasks.size).toBe(0);
  });

  it("echoes an activated extension and carries the envelope core only when it is activated", async () => {
    const ctx = createA2aTestApp();
    const { publicId } = await openA2aAgent(ctx);

    const plain = await sendText(ctx, publicId, "Hello").expect(200);
    const activated = await sendText(ctx, publicId, "Hello", {}, {
      extensions: `https://other.example/ext, ${A2A_CONVERSE_EXTENSION_URI}`,
    }).expect(200);

    expect(plain.headers["a2a-extensions"]).toBeUndefined();
    expect(plain.body.result.message.metadata).toBeUndefined();
    expect(activated.headers["a2a-extensions"]).toBe(A2A_CONVERSE_EXTENSION_URI);
    expect(activated.body.result.message.metadata).toEqual({
      [A2A_CONVERSE_EXTENSION_URI]: {
        answerCoverage: expect.objectContaining({ availability: expect.any(String) }),
        ownership: { state: "ai_owned", suppressed: false },
        citations: [],
        author: "agent",
      },
    });
  });

  it("answers an unknown, card-off, or unpublished agent with the card's own 404", async () => {
    const ctx = createA2aTestApp();
    const { session, agent, publicId } = await openA2aAgent(ctx);
    const cardNotFound = await request(ctx.app).get("/.well-known/agent-card/ag_unknownunknownunknown.json");

    const unknown = await sendText(ctx, "ag_unknownunknownunknown", "Hello");
    await request(ctx.app).put(`/api/v1/agents/${agent.id}`).set(adminSessionHeaders(session)).send({ agentCardEnabled: false, publicAgentAccessEnabled: false }).expect(200);
    const cardOff = await sendText(ctx, publicId, "Hello");

    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(cardNotFound.body);
    expect(cardOff.status).toBe(404);
    expect(cardOff.body).toEqual(cardNotFound.body);
  });
});

describe("A2A binding: access (FR-020 to FR-023)", () => {
  it("refuses a caller with no credential when walk-in is off, and serves one with a converse grant", async () => {
    const ctx = createA2aTestApp();
    const { agent, publicId } = await openA2aAgent(ctx, { publicAgentAccessEnabled: false });
    const grant = await issueConverseGrant(ctx, agent);

    const refused = await sendText(ctx, publicId, "Hello");
    const served = await sendText(ctx, publicId, "Hello", {}, { bearer: grant.token }).expect(200);

    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toEqual({ code: "walk_in_unavailable" });
    expect(JSON.stringify(refused.body)).not.toContain(agent.id);
    expect(served.body.result.message.parts).toEqual([{ text: "agent:Hello" }]);
  });

  it("opens a fresh conversation for each grant context, and continues one only under the same grant", async () => {
    const ctx = createA2aTestApp();
    const { agent, publicId } = await openA2aAgent(ctx, { publicAgentAccessEnabled: false });
    const grant = await issueConverseGrant(ctx, agent);
    const otherGrant = await issueConverseGrant(ctx, agent);

    const first = await sendText(ctx, publicId, "One", {}, { bearer: grant.token }).expect(200);
    const second = await sendText(ctx, publicId, "Two", {}, { bearer: grant.token }).expect(200);
    const contextId = first.body.result.message.contextId as string;
    expect(await conversationIdForContext(ctx, contextId))
      .not.toBe(await conversationIdForContext(ctx, second.body.result.message.contextId));

    const continued = await sendText(ctx, publicId, "Three", { contextId }, { bearer: grant.token }).expect(200);
    const underOtherGrant = await sendText(ctx, publicId, "Four", { contextId }, { bearer: otherGrant.token }).expect(200);
    const withoutGrant = await sendText(ctx, publicId, "Five", { contextId }).expect(200);

    expect(continued.body.result.message.contextId).toBe(contextId);
    for (const refused of [underOtherGrant, withoutGrant]) {
      expect(refused.body.error).toMatchObject({ code: -32602, data: [{ reason: "CONTEXT_NOT_FOUND", domain: "radioso.ai", metadata: {} }] });
    }
  });

  it("ends a grant context once the grant is revoked, answering exactly as for a context it never issued", async () => {
    const ctx = createA2aTestApp();
    const { agent, publicId } = await openA2aAgent(ctx, { publicAgentAccessEnabled: false });
    const grant = await issueConverseGrant(ctx, agent);
    const first = await sendText(ctx, publicId, "One", {}, { bearer: grant.token }).expect(200);

    await ctx.dependencies.accessGrantService.revokeGrant({ grantId: grant.grantId });
    const revoked = await sendText(ctx, publicId, "Two", { contextId: first.body.result.message.contextId }, { bearer: grant.token }).expect(200);
    const forged = await sendText(ctx, publicId, "Two", { contextId: "bm90LWEtY29udGV4dA" }).expect(200);

    expect(revoked.body.error).toEqual(forged.body.error);
    expect(forged.body.error.data[0].reason).toBe("CONTEXT_NOT_FOUND");
  });

  it("refuses another agent's context as one it never issued", async () => {
    const ctx = createA2aTestApp();
    const first = await openA2aAgent(ctx);
    const second = await openA2aAgent(ctx);
    const opened = await sendText(ctx, first.publicId, "Hello").expect(200);

    const crossed = await sendText(ctx, second.publicId, "Hello", { contextId: opened.body.result.message.contextId }).expect(200);

    expect(crossed.body.error).toMatchObject({ code: -32602, data: [{ reason: "CONTEXT_NOT_FOUND" }] });
  });

  it("spends one walk-in conversation budget across MCP and A2A, answering 429 before dispatch", async () => {
    const ctx = createA2aTestApp({ abuseControlRepository: new InMemoryAbuseControlRepository() });
    const { publicId } = await openA2aAgent(ctx, { walkInConversationsPerHour: 1 });

    await request(ctx.app).post("/api/v1/mcp/converse/session").send({ publicId }).expect(201);
    const throttled = await sendText(ctx, publicId, "Hello");

    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttled.headers["ratelimit-limit"]).toBe("1");
    expect(throttled.headers["ratelimit-remaining"]).toBe("0");
    expect(ctx.stores.tasks.tasks.size).toBe(0);
  });
});

describe("A2A binding: idempotent sends (FR-038)", () => {
  it("returns the original result for a repeated messageId in a context, without running a second turn", async () => {
    const ctx = createA2aTestApp();
    const { agent, publicId } = await openA2aAgent(ctx);
    const opened = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = opened.body.result.message.contextId as string;
    const conversationId = await conversationIdForContext(ctx, contextId);

    const original = await sendText(ctx, publicId, "Where is my parcel?", { contextId, messageId: "client-7" }).expect(200);
    const retried = await sendText(ctx, publicId, "Where is my parcel?", { contextId, messageId: "client-7" }).expect(200);

    expect(retried.body.result).toEqual(original.body.result);
    const messages = await ctx.repositories.messageRepository.listByConversationId(agent.workspaceId, conversationId);
    expect(messages.filter((message) => message.content === "Where is my parcel?")).toHaveLength(1);
  });

  it("returns the original task for a repeated messageId whose send opened one", async () => {
    const ctx = createA2aTestApp();
    const { session, agent, publicId } = await openA2aAgent(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(session.workspaceId, agent.id, supportIntakeDraft());
    const opened = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = opened.body.result.task.contextId as string;

    const taskId = opened.body.result.task.id as string;

    const original = await sendText(ctx, publicId, "topic: billing", { contextId, taskId, messageId: "client-8" }).expect(200);
    // The task is terminal now; a retry of the send that finished it still replays it.
    const retried = await sendText(ctx, publicId, "topic: billing", { contextId, taskId, messageId: "client-8" }).expect(200);

    expect(original.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(retried.body.result).toEqual(original.body.result);
  });
});

describe("A2A binding: ListTasks scoping (FR-036)", () => {
  it("lists one context's tasks, and nothing without a context", async () => {
    const ctx = createA2aTestApp();
    const { session, agent, publicId } = await openA2aAgent(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(session.workspaceId, agent.id, supportIntakeDraft());
    const first = await sendText(ctx, publicId, "I need support intake").expect(200);
    const second = await sendText(ctx, publicId, "I need support intake").expect(200);

    const unscoped = await rpc(ctx, publicId, "ListTasks", {}).expect(200);
    const scoped = await rpc(ctx, publicId, "ListTasks", { contextId: first.body.result.task.contextId }).expect(200);

    expect(unscoped.body.result).toEqual({ tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 });
    expect(scoped.body.result).toMatchObject({ nextPageToken: "", pageSize: 50, totalSize: 1 });
    expect(scoped.body.result.tasks.map((task: { id: string }) => task.id)).toEqual([first.body.result.task.id]);
    expect(scoped.body.result.tasks[0].id).not.toBe(second.body.result.task.id);
  });
});

