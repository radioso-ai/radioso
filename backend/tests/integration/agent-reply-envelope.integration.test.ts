import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { ChatResponse } from "../../src/modules/chat/contracts/index.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const plainGateway: ChatGateway = {
  async answer(input) {
    return `agent:${input.query}`;
  },
  async *streamAnswer(input) {
    yield `agent:${input.query}`;
  },
};

/** Activates any registered routine and answers routine steps with a fixed reply. */
const routineGateway: ChatGateway = {
  async answer(input) {
    if (input.systemPrompt?.includes("wants to start any registered routine")) {
      const routineId = input.systemPrompt.match(/id: (\S+)/)?.[1];
      return JSON.stringify({ matches: routineId ? [{ routineId, confidence: 0.95, variables: {} }] : [] });
    }
    if (input.systemPrompt?.includes("conditions")) {
      return "{}";
    }
    return "What topic can I help you with?";
  },
  async *streamAnswer() {
    yield "What topic can I help you with?";
  },
};

const supportIntakeRoutineDraft = (): RoutineDefinitionDraftInput => ({
  name: "Support intake",
  enabled: true,
  activation: {
    triggerDescription: "When the user asks to start support intake.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [
    { stableSlotId: "slot_topic", key: "topic", type: "text", required: true, description: "The support topic", ordinal: 0 },
    { stableSlotId: "slot_urgency", key: "urgency", type: "text", required: false, description: "How urgent it is", ordinal: 1 },
  ],
  steps: [{
    stableStepId: "step_collect_topic",
    kind: "chat",
    instruction: "Ask for {{slot.topic}} and {{slot.urgency}}.",
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "terminal_complete",
    guardKind: "llm",
    guardText: "The user provided {{slot.topic}}.",
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: "Complete intake for {{slot.topic}}.",
    ordinal: 1,
  }],
});

const parseSseEvents = (body: string): Array<{ event: string; data: Record<string, unknown> }> =>
  body.trim().split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (!event || !data) {
      throw new Error(`Malformed SSE block: ${block}`);
    }
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });

const createApp = (chatGateway: ChatGateway = plainGateway) =>
  createTestApp({
    chatGateway,
    turnRouter: {
      async classify() {
        return { route: "direct" as const, framing: { isIdentityQuestion: false } };
      },
    },
    applicationRouteMounts: [{
      path: "/api/v1/mcp/converse",
      createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
    }],
  });

type App = ReturnType<typeof createApp>;

const issueRestCredential = async (ctx: App) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const { token } = await ctx.dependencies.accessGrantService.issueGrant({
    agentId: agent.id,
    workspaceId: session.workspaceId,
    principalKind: "agent-api",
    channel: "agent-api",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { agent, token, workspaceId: session.workspaceId, accountId: session.accountId };
};

const openConverseSession = async (ctx: App) => {
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
  const exchange = await request(ctx.app).post("/api/v1/mcp/converse/session").send({ launchToken: token });
  expect(exchange.status).toBe(201);
  return { agent, workspaceId: session.workspaceId, sessionToken: exchange.body.sessionToken as string, publicConversationId: exchange.body.conversationId as string };
};

const restChat = (ctx: App, agentId: string, token: string, body: Record<string, unknown>) =>
  request(ctx.app)
    .post(`/api/v1/agents/${agentId}/chat`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const converseAsk = (ctx: App, sessionToken: string, message: string) =>
  request(ctx.app)
    .post("/api/v1/mcp/converse/ask")
    .set("Authorization", `Bearer ${sessionToken}`)
    .send({ message });

describe("agent reply envelope (US1)", () => {
  it("carries the recorded coverage verdict verbatim on both routes (AS-1, AS-2)", async () => {
    const ctx = createApp();
    const rest = await issueRestCredential(ctx);
    const converse = await openConverseSession(ctx);
    const recorded: Array<ChatResponse["answerCoverage"]> = [
      { availability: "assessed", coverage: "answered", reason: "sufficient_evidence", originatingTurnId: "request-1", originatingRequestId: "request-1" },
      { availability: "assessed", coverage: "unanswered", reason: "intentional_scope_boundary", unresolvedRequest: "Pricing for competitors", originatingTurnId: "request-2", originatingRequestId: "request-2" },
    ];
    const answer = ctx.dependencies.assistantChatService.answer.bind(ctx.dependencies.assistantChatService);
    let turn = 0;
    ctx.dependencies.assistantChatService.answer = async (input) => {
      const response = await answer(input);
      return response ? { ...response, answerCoverage: recorded[turn++ % recorded.length] } : response;
    };

    const grounded = await restChat(ctx, rest.agent.id, rest.token, { message: "What is the refund window?", stream: false });
    const outOfScope = await converseAsk(ctx, converse.sessionToken, "How much do competitors charge?");

    expect(grounded.status).toBe(200);
    expect(grounded.body.answerCoverage).toEqual(recorded[0]);
    expect(grounded.body.answer).toBe("agent:What is the refund window?");
    expect(grounded.body).not.toHaveProperty("debug");
    expect(outOfScope.status).toBe(200);
    expect(outOfScope.body.answerCoverage).toEqual(recorded[1]);
    expect(outOfScope.body.answer.text).toBe("agent:How much do competitors charge?");
    expect(outOfScope.body.answer.citations).toEqual([]);
    expect(outOfScope.body.conversationId).toBe(converse.publicConversationId);
  });

  it("always carries answerCoverage, falling back to not_recorded when no assessment ran", async () => {
    const ctx = createApp();
    const rest = await issueRestCredential(ctx);

    const response = await restChat(ctx, rest.agent.id, rest.token, { message: "hi", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answerCoverage).toEqual({
      availability: "not_recorded",
      originatingTurnId: expect.any(String),
      originatingRequestId: expect.any(String),
    });
    expect(response.body.ownership).toEqual({ state: "ai_owned", suppressed: false });
    expect(response.body).not.toHaveProperty("routine");
  });

  it("tells a caller nothing was generated once a human owns the conversation (AS-3)", async () => {
    const ctx = createApp();
    const rest = await issueRestCredential(ctx);
    const first = await restChat(ctx, rest.agent.id, rest.token, { message: "I want to talk to a person", stream: false });
    expect(first.status).toBe(200);
    const conversationId = first.body.conversationId as string;
    const takeover = await ctx.repositories.conversationOwnershipRepository.takeOver({
      conversationId,
      workspaceId: rest.workspaceId,
      accountId: rest.accountId,
      displayName: "Sam",
    });
    expect(takeover.ok).toBe(true);

    const suppressed = await restChat(ctx, rest.agent.id, rest.token, { message: "Are you there?", conversationId, stream: false });

    expect(suppressed.status).toBe(200);
    expect(suppressed.body.conversationId).toBe(conversationId);
    expect(suppressed.body.ownership).toEqual({ state: "human_owned", suppressed: true });
    expect(suppressed.body.answerCoverage).toMatchObject({ availability: "not_recorded" });
  });

  it("reports the human-owned conversation on the MCP converse route too (AS-3)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    const first = await converseAsk(ctx, converse.sessionToken, "I want to talk to a person");
    expect(first.status).toBe(200);
    const conversations = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      converse.workspaceId,
      converse.publicConversationId,
      { limit: 1, agentId: converse.agent.id },
    );
    const conversationId = conversations.conversations[0].id;
    const session = await issueTestSession(ctx.app);
    await ctx.repositories.conversationOwnershipRepository.takeOver({
      conversationId,
      workspaceId: converse.workspaceId,
      accountId: session.accountId,
      displayName: "Sam",
    });

    const suppressed = await converseAsk(ctx, converse.sessionToken, "Are you there?");

    expect(suppressed.status).toBe(200);
    expect(suppressed.body.conversationId).toBe(converse.publicConversationId);
    expect(suppressed.body.ownership).toEqual({ state: "human_owned", suppressed: true });
  });

  it("lists the slots a mid-collection routine still needs (AS-4)", async () => {
    const ctx = createApp(routineGateway);
    const rest = await issueRestCredential(ctx);
    const draft = await ctx.dependencies.routineDefinitionService.createDraft(rest.workspaceId, rest.agent.id, supportIntakeRoutineDraft());
    expect(draft.routine.enabled).toBe(true);

    const response = await restChat(ctx, rest.agent.id, rest.token, { message: "I need support intake", stream: false });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe("What topic can I help you with?");
    expect(response.body.routine).toEqual({
      name: "Support intake",
      status: "waiting_for_input",
      pendingInput: [
        { key: "topic", type: "text", required: true, description: "The support topic" },
        { key: "urgency", type: "text", required: false, description: "How urgent it is" },
      ],
    });
    expect(response.body.ownership).toEqual({ state: "ai_owned", suppressed: false });
  });

  it("carries the same envelope core in the SSE done frame (AS-5)", async () => {
    const ctx = createApp(routineGateway);
    const rest = await issueRestCredential(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(rest.workspaceId, rest.agent.id, supportIntakeRoutineDraft());

    const stream = await restChat(ctx, rest.agent.id, rest.token, { message: "I need support intake", stream: true });

    expect(stream.status).toBe(200);
    const events = parseSseEvents(stream.text);
    const done = events.find((event) => event.event === "done");
    expect(done).toBeDefined();
    expect(done?.data).toMatchObject({
      conversationId: expect.any(String),
      answer: "What topic can I help you with?",
      answerCoverage: { availability: "not_recorded" },
      ownership: { state: "ai_owned", suppressed: false },
      routine: {
        name: "Support intake",
        status: "waiting_for_input",
        pendingInput: [
          { key: "topic", type: "text", required: true, description: "The support topic" },
          { key: "urgency", type: "text", required: false, description: "How urgent it is" },
        ],
      },
    });
    expect(done?.data).not.toHaveProperty("debug");
  });
});
