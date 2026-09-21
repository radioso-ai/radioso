import { describe, expect, it } from "vitest";
import request from "supertest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { createTestApp, issueTestSession } from "../support/testApp.js";

const RANKED_ACTIVATION_MARKER = "wants to start any registered routine";

/**
 * Activates any registered routine on a message turn, answers step replies with a
 * fixed line, and never advances a re-asked step. Counts ranked-activation calls so a
 * test can prove an invocation turn made none.
 */
const createRoutineGateway = () => {
  const calls = { rankedActivation: 0 };
  const gateway: ChatGateway = {
    async answer(input) {
      if (input.systemPrompt?.includes(RANKED_ACTIVATION_MARKER)) {
        calls.rankedActivation += 1;
        const routineId = input.systemPrompt.match(/id: (\S+)/)?.[1];
        return JSON.stringify({ matches: routineId ? [{ routineId, confidence: 0.95, variables: {} }] : [] });
      }
      if (input.systemPrompt?.includes("conditions")) {
        return "{}";
      }
      return `routine:${input.query}`;
    },
    async *streamAnswer(input) {
      yield `routine:${input.query}`;
    },
  };
  return { gateway, calls };
};

const chatStep = (stableStepId: string, instruction: string, ordinal: number): RoutineDefinitionDraftInput["steps"][number] => ({
  stableStepId,
  kind: "chat",
  instruction,
  toolRef: null,
  ordinal,
  metadata: {},
});

const edge = (fromStep: string, toRef: string, ordinal: number): RoutineDefinitionDraftInput["transitions"][number] => ({
  fromStep,
  toRef,
  guardKind: "default",
  guardText: null,
  ordinal,
});

const startReturnDraft = (overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
  name: "Start a return",
  enabled: true,
  activation: {
    triggerDescription: "When the user wants to return an order.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  exposure: { enabled: true, toolName: "start_return", description: "Start a return for an order." },
  slots: [
    { stableSlotId: "slot_order", key: "orderId", type: "text", required: true, description: "The order number", ordinal: 0 },
    { stableSlotId: "slot_reason", key: "reason", type: "text", required: false, description: "Why it is coming back", ordinal: 1 },
  ],
  steps: [
    chatStep("ask_order", "Ask for {{slot.orderId}}.", 0),
    chatStep("ask_reason", "Ask for {{slot.reason}}.", 1),
  ],
  transitions: [edge("ask_order", "ask_reason", 0), edge("ask_reason", "done", 1)],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the return for {{slot.orderId}}.", ordinal: 2 }],
  ...overrides,
});

const supportIntakeDraft = (): RoutineDefinitionDraftInput => ({
  name: "Support intake",
  enabled: true,
  activation: {
    triggerDescription: "When the user asks to start support intake.",
    gateRef: null,
    priority: 20,
    reentryMode: "once_per_conversation",
  },
  slots: [{ stableSlotId: "slot_topic", key: "topic", type: "text", required: true, description: "The support topic", ordinal: 0 }],
  steps: [chatStep("step_collect_topic", "Ask for {{slot.topic}}.", 0)],
  transitions: [{ fromStep: "step_collect_topic", toRef: "terminal_complete", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Complete intake.", ordinal: 1 }],
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

const createApp = () => {
  const routineGateway = createRoutineGateway();
  const ctx = createTestApp({
    chatGateway: routineGateway.gateway,
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
  return { ...ctx, gatewayCalls: routineGateway.calls };
};

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
  return { agent, token, workspaceId: session.workspaceId };
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
  return {
    agent,
    workspaceId: session.workspaceId,
    sessionToken: exchange.body.sessionToken as string,
    publicConversationId: exchange.body.conversationId as string,
  };
};

const restChat = (ctx: App, agentId: string, token: string, body: Record<string, unknown>) =>
  request(ctx.app).post(`/api/v1/agents/${agentId}/chat`).set("Authorization", `Bearer ${token}`).send(body);

const converseAsk = (ctx: App, sessionToken: string, body: Record<string, unknown>) =>
  request(ctx.app).post("/api/v1/mcp/converse/ask").set("Authorization", `Bearer ${sessionToken}`).send(body);

const converseTools = (ctx: App, sessionToken: string) =>
  request(ctx.app).get("/api/v1/mcp/converse/tools").set("Authorization", `Bearer ${sessionToken}`);

const startReturnDescriptor = (routineLineageId: string) => ({
  toolName: "start_return",
  description: "Start a return for an order.",
  routineLineageId,
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order number" },
      reason: { type: "string", description: "Why it is coming back" },
    },
    required: ["orderId"],
    additionalProperties: false,
  },
});

describe("routine invocation (US2)", () => {
  it("lists an exposed, enabled routine as a tool with a schema built from its slots (AS-1)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    const draft = await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, supportIntakeDraft());

    const response = await converseTools(ctx, converse.sessionToken);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      agent: { name: converse.agent.name, description: null },
      tools: [startReturnDescriptor(draft.routine.lineageId)],
    });
  });

  it("admits the routine directly, fast-forwards filled slots, and reports the routine state (AS-2)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());

    const partial = await converseAsk(ctx, converse.sessionToken, { routine: { toolName: "start_return", input: { orderId: "A-1001" } } });

    expect(partial.status).toBe(200);
    expect(partial.body.routine).toEqual({
      toolName: "start_return",
      name: "Start a return",
      status: "waiting_for_input",
      pendingInput: [{ key: "reason", type: "text", required: false, description: "Why it is coming back" }],
    });
    expect(partial.body.ownership).toEqual({ state: "ai_owned", suppressed: false });
    expect(partial.body.answerCoverage).toMatchObject({ availability: "not_recorded" });
    expect(ctx.gatewayCalls.rankedActivation).toBe(0);

    const conversations = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      converse.workspaceId,
      converse.publicConversationId,
      { limit: 1, agentId: converse.agent.id },
    );
    const messages = await ctx.repositories.messageRepository.listByConversationId(converse.workspaceId, conversations.conversations[0].id);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: 'start_return {"orderId":"A-1001"}',
      inputMetadata: { method: "routine_invocation", routine: { toolName: "start_return", input: { orderId: "A-1001" } } },
    });
  });

  it("completes the routine in one call when every collected slot is supplied (AS-2)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());

    const full = await converseAsk(ctx, converse.sessionToken, {
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
    });

    expect(full.status).toBe(200);
    expect(full.body.routine).toEqual({ toolName: "start_return", name: "Start a return", status: "completed", pendingInput: [] });
  });

  it("rejects bad input before any turn is recorded (AS-3)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());

    const invalid = await converseAsk(ctx, converse.sessionToken, {
      routine: { toolName: "start_return", input: { reason: 7, note: "fragile" } },
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: "bad_request",
      details: {
        code: "routine_invocation_invalid",
        errors: [
          { path: "orderId", code: "required" },
          { path: "reason", code: "type" },
          { path: "note", code: "unknown_field" },
        ],
      },
    });
    const conversations = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
      converse.workspaceId,
      converse.publicConversationId,
      { limit: 1, agentId: converse.agent.id },
    );
    expect(conversations.conversations).toHaveLength(0);
    expect([...ctx.repositories.messageRepository.items.values()].flat()).toHaveLength(0);
  });

  it("creates the approval exactly as chat does and reports waiting_for_approval (AS-4)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    const draft = await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft({
      slots: [{ stableSlotId: "slot_order", key: "orderId", type: "text", required: true, description: "The order number", ordinal: 0 }],
      steps: [
        chatStep("ask_order", "Ask for {{slot.orderId}}.", 0),
        {
          stableStepId: "approve",
          kind: "approval",
          instruction: "Approve the return for {{slot.orderId}}.",
          toolRef: null,
          captureKey: "decision",
          options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
          ordinal: 1,
          metadata: {},
        },
      ],
      transitions: [
        edge("ask_order", "approve", 0),
        { fromStep: "approve", toRef: "done", guardKind: "field", guardText: null, fieldRef: "decision.id", fieldOp: "equals", fieldValue: "approve", ordinal: 1 },
        { fromStep: "approve", toRef: "declined", guardKind: "field", guardText: null, fieldRef: "decision.id", fieldOp: "equals", fieldValue: "reject", ordinal: 2 },
      ],
      terminals: [
        { stableStepId: "done", kind: "complete", instruction: "Confirm the return for {{slot.orderId}}.", ordinal: 3 },
        { stableStepId: "declined", kind: "complete", instruction: "Explain the return was declined.", ordinal: 4 },
      ],
    }));
    expect(draft.validation).toEqual({ ok: true, diagnostics: [] });

    const response = await converseAsk(ctx, converse.sessionToken, { routine: { toolName: "start_return", input: { orderId: "A-1001" } } });

    expect(response.status).toBe(200);
    expect(response.body.routine).toEqual({ toolName: "start_return", name: "Start a return", status: "waiting_for_approval", pendingInput: [] });
  });

  it("answers normally on a second call to a completed once_per_conversation routine and still names it (AS-5)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());
    const first = await converseAsk(ctx, converse.sessionToken, {
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
    });
    expect(first.body.routine.status).toBe("completed");

    const second = await converseAsk(ctx, converse.sessionToken, {
      routine: { toolName: "start_return", input: { orderId: "A-2002" } },
    });

    expect(second.status).toBe(200);
    expect(second.body.answer.text).toBe('routine:start_return {"orderId":"A-2002"}');
    expect(second.body.routine).toEqual({ toolName: "start_return", name: "Start a return", status: "completed", pendingInput: [] });
    expect(ctx.gatewayCalls.rankedActivation).toBe(0);
  });

  it("re-enters a completed routine under always reentry with the new input and no model decision (AS-5)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft({
      activation: { triggerDescription: "When the user wants to return an order.", gateRef: null, priority: 10, reentryMode: "always" },
    }));
    const first = await converseAsk(ctx, converse.sessionToken, {
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
    });
    expect(first.body.routine.status).toBe("completed");

    const second = await converseAsk(ctx, converse.sessionToken, { routine: { toolName: "start_return", input: { orderId: "A-2002" } } });

    expect(second.status).toBe(200);
    expect(second.body.routine).toEqual({
      toolName: "start_return",
      name: "Start a return",
      status: "waiting_for_input",
      pendingInput: [{ key: "reason", type: "text", required: false, description: "Why it is coming back" }],
    });
    expect(ctx.gatewayCalls.rankedActivation).toBe(0);
  });

  it("follows the existing interruption rules when a different routine is active and reports that routine (AS-6)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, supportIntakeDraft());
    const intake = await converseAsk(ctx, converse.sessionToken, { message: "I need support intake" });
    expect(intake.body.routine).toMatchObject({ name: "Support intake", status: "waiting_for_input" });

    const invoked = await converseAsk(ctx, converse.sessionToken, { routine: { toolName: "start_return", input: { orderId: "A-1001" } } });

    expect(invoked.status).toBe(200);
    expect(invoked.body.routine).toMatchObject({ name: "Support intake", status: "waiting_for_input" });
    expect(invoked.body.routine).not.toHaveProperty("toolName");
  });

  it("never lets an unrelated completed routine capture an invocation turn (AS-6)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft());
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft({
      name: "Request a callback",
      exposure: { enabled: true, toolName: "request_callback", description: "Ask for a callback." },
      slots: [{ stableSlotId: "slot_phone", key: "phone", type: "text", required: true, description: "Phone number", ordinal: 0 }],
      steps: [chatStep("ask_phone", "Ask for {{slot.phone}}.", 0)],
      transitions: [edge("ask_phone", "done", 0)],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the callback.", ordinal: 1 }],
    }));
    const completed = await converseAsk(ctx, converse.sessionToken, {
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
    });
    expect(completed.body.routine.status).toBe("completed");

    const other = await converseAsk(ctx, converse.sessionToken, { routine: { toolName: "request_callback", input: { phone: "+1 555 0100" } } });

    expect(other.status).toBe(200);
    expect(other.body.routine).toEqual({ toolName: "request_callback", name: "Request a callback", status: "completed", pendingInput: [] });
  });

  it("drops a routine from the catalog and refuses its tool once exposure is disabled (AS-7)", async () => {
    const ctx = createApp();
    const converse = await openConverseSession(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(converse.workspaceId, converse.agent.id, startReturnDraft({
      exposure: { enabled: false, toolName: "start_return", description: "Start a return for an order." },
    }));

    const tools = await converseTools(ctx, converse.sessionToken);
    const invoked = await converseAsk(ctx, converse.sessionToken, { routine: { toolName: "start_return", input: { orderId: "A-1001" } } });

    expect(tools.body.tools).toEqual([]);
    expect(invoked.status).toBe(404);
    expect(invoked.body.error).toMatchObject({ code: "not_found", details: { code: "routine_tool_unknown", toolName: "start_return" } });
  });

  it("accepts the same routine body on the REST agent channel, as JSON and in the SSE done frame (AS-9)", async () => {
    const ctx = createApp();
    const rest = await issueRestCredential(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(rest.workspaceId, rest.agent.id, startReturnDraft());

    const json = await restChat(ctx, rest.agent.id, rest.token, { routine: { toolName: "start_return", input: { orderId: "A-1001" } }, stream: false });
    const stream = await restChat(ctx, rest.agent.id, rest.token, {
      routine: { toolName: "start_return", input: { orderId: "A-1001", reason: "Wrong size" } },
      stream: true,
    });
    const both = await restChat(ctx, rest.agent.id, rest.token, { message: "hi", routine: { toolName: "start_return", input: {} } });

    expect(json.status).toBe(200);
    expect(json.body.routine).toEqual({
      toolName: "start_return",
      name: "Start a return",
      status: "waiting_for_input",
      pendingInput: [{ key: "reason", type: "text", required: false, description: "Why it is coming back" }],
    });
    expect(json.body.ownership).toEqual({ state: "ai_owned", suppressed: false });
    expect(stream.status).toBe(200);
    const done = parseSseEvents(stream.text).find((event) => event.event === "done");
    expect(done?.data).toMatchObject({
      routine: { toolName: "start_return", name: "Start a return", status: "completed", pendingInput: [] },
      ownership: { state: "ai_owned", suppressed: false },
    });
    expect(both.status).toBe(400);
  });
});
