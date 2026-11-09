import request from "supertest";

import { createA2aErrorHandler, createA2aRouter } from "../../src/app/composition/a2a.js";
import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import { buildMcpConverseServices } from "../../src/app/server/dependencyBuilders.js";
import { createA2aContextSealer } from "../../src/modules/a2a/public.js";
import { A2A_ENDPOINT_MOUNT_PATH } from "../../src/modules/agentDiscovery/public.js";
import type { A2aMessageReceiptStore, A2aTaskStore } from "../../src/modules/a2a/public.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import type { UsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { InMemoryA2aMessageReceiptStore, InMemoryA2aTaskStore } from "./a2aStores.js";
import type { InMemoryAbuseControlRepository } from "./fakes.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "./testApp.js";

/** The key `createTestApp` configures as `CONNECTOR_ENCRYPTION_KEY`, so a test can read a context it was handed. */
const TEST_FIELD_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

const RANKED_ACTIVATION_MARKER = "wants to start any registered routine";
const ROUTINE_STEP_SELECTOR_MARKER = "You are guiding a user through a structured, multi-step routine";

/**
 * Answers plain turns with `agent:<message>`, activates any registered routine on a message that
 * does not say `no routine`, and drives a routine step from the message: `topic: <value>` fills the
 * `topic` slot and takes the step's exit, a message containing `unrelated` yields the routine as
 * off-topic, and anything else re-asks the step.
 */
export const a2aTestGateway: ChatGateway = {
  async answer(input) {
    const systemPrompt = input.systemPrompt ?? "";
    if (systemPrompt.includes(RANKED_ACTIVATION_MARKER)) {
      const routineId = input.query.includes("no routine") ? undefined : systemPrompt.match(/id: (\S+)/)?.[1];
      return JSON.stringify({ matches: routineId ? [{ routineId, confidence: 0.95, variables: {} }] : [] });
    }
    if (systemPrompt.includes(ROUTINE_STEP_SELECTOR_MARKER)) {
      const decision = { claimsAuthority: false, offTopic: false };
      if (input.query.includes("unrelated")) {
        return JSON.stringify({ ...decision, offTopic: true, condition: null, variables: {} });
      }
      if (input.query.startsWith("topic:")) {
        return JSON.stringify({ ...decision, condition: 1, variables: { topic: input.query.slice("topic:".length).trim() } });
      }
      return JSON.stringify({ ...decision, condition: null, variables: {} });
    }
    if (systemPrompt.includes("conditions")) {
      return "{}";
    }
    return `agent:${input.query}`;
  },
  async *streamAnswer(input) {
    yield `agent:${input.query}`;
  },
};

/** One required slot, one chat step, completed once the slot is given. */
export const supportIntakeDraft = (): RoutineDefinitionDraftInput => ({
  name: "Support intake",
  enabled: true,
  activation: {
    triggerDescription: "When the user asks to start support intake.",
    gateRef: null,
    priority: 20,
    reentryMode: "once_per_conversation",
  },
  slots: [{ stableSlotId: "slot_topic", key: "topic", type: "text", required: true, description: "The support topic", ordinal: 0 }],
  steps: [{ stableStepId: "step_collect_topic", kind: "chat", instruction: "Ask for {{slot.topic}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_collect_topic", toRef: "terminal_complete", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Complete intake.", ordinal: 1 }],
});

/** `supportIntakeDraft`, with an operator's approval between the topic and the end. */
export const supportIntakeWithApprovalDraft = (): RoutineDefinitionDraftInput => ({
  ...supportIntakeDraft(),
  steps: [
    { stableStepId: "step_collect_topic", kind: "chat", instruction: "Ask for {{slot.topic}}.", toolRef: null, ordinal: 0, metadata: {} },
    {
      stableStepId: "step_approve",
      kind: "approval",
      instruction: "Approve intake for {{slot.topic}}.",
      toolRef: null,
      captureKey: "decision",
      options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      ordinal: 1,
      metadata: {},
    },
  ],
  transitions: [
    { fromStep: "step_collect_topic", toRef: "step_approve", guardKind: "llm", guardText: "The user provided {{slot.topic}}.", ordinal: 0 },
    { fromStep: "step_approve", toRef: "terminal_complete", guardKind: "field", guardText: null, fieldRef: "decision.id", fieldOp: "equals", fieldValue: "approve", ordinal: 1 },
    { fromStep: "step_approve", toRef: "terminal_declined", guardKind: "field", guardText: null, fieldRef: "decision.id", fieldOp: "equals", fieldValue: "reject", ordinal: 2 },
  ],
  terminals: [
    { stableStepId: "terminal_complete", kind: "complete", instruction: "Complete intake.", ordinal: 2 },
    { stableStepId: "terminal_declined", kind: "complete", instruction: "Explain the intake was declined.", ordinal: 3 },
  ],
});

const directTurnRouter: TurnRouter = {
  async classify() {
    return { route: "direct" as const, framing: { isIdentityQuestion: false } };
  },
};

interface A2aTestStores {
  tasks: A2aTaskStore;
  receipts: A2aMessageReceiptStore;
}

type InMemoryA2aStores = { tasks: InMemoryA2aTaskStore; receipts: InMemoryA2aMessageReceiptStore };

export const createA2aTestApp = <Stores extends A2aTestStores = InMemoryA2aStores>(options: {
  abuseControlRepository?: InMemoryAbuseControlRepository;
  envOverrides?: Record<string, unknown>;
  usageLimitPolicy?: UsageLimitPolicy;
  /** The task and receipt stores; in memory unless a test hands in the Postgres ones. */
  stores?: Stores;
  turnRouter?: TurnRouter;
} = {}) => {
  const { stores: givenStores, turnRouter, ...appOptions } = options;
  // The default type argument is the in-memory pair, which is what is built when none is handed in.
  const stores = givenStores ?? ({ tasks: new InMemoryA2aTaskStore(), receipts: new InMemoryA2aMessageReceiptStore() } as A2aTestStores as Stores);
  const ctx = createTestApp({
    ...appOptions,
    envOverrides: { METRICS_ENABLED: true, METRICS_AUTH_TOKEN: "metrics-test-token", ...options.envOverrides },
    chatGateway: a2aTestGateway,
    turnRouter: turnRouter ?? directTurnRouter,
    applicationRouteMounts: [
      {
        path: "/api/v1/mcp/converse",
        createRouter: (dependencies) => createMcpConverseRoutes(dependencies, buildMcpConverseServices(dependencies)),
      },
      {
        path: A2A_ENDPOINT_MOUNT_PATH,
        createRouter: (dependencies) => createA2aRouter(dependencies, stores),
        createErrorHandler: (dependencies) => createA2aErrorHandler(dependencies),
      },
    ],
  });
  return { ...ctx, stores };
};

export type A2aTestApp = ReturnType<typeof createA2aTestApp<A2aTestStores>>;

/** The default agent, its card on and (unless told otherwise) its walk-in door open. */
export const openA2aAgent = async (ctx: A2aTestApp, body: Record<string, unknown> = {}) => {
  const session = await issueTestSession(ctx.app);
  const agent = await ctx.dependencies.agentService.resolve(session.workspaceId);
  const updated = await request(ctx.app)
    .put(`/api/v1/agents/${agent.id}`)
    .set(adminSessionHeaders(session))
    .send({ agentCardEnabled: true, publicAgentAccessEnabled: true, publicDescription: "Answers support questions.", ...body })
    .expect(200);
  return { session, agent, publicId: updated.body.publicId as string };
};

/** An operator in the Inbox: take a conversation over, reply in it, and hand it back. */
export const operatorOf = (ctx: A2aTestApp, session: Awaited<ReturnType<typeof issueTestSession>>, conversationId: string) => ({
  takeOver: () => request(ctx.app)
    .post(`/api/v1/conversations/${conversationId}/takeover`)
    .set(adminSessionHeaders(session))
    .send({ reason: "Needs a person" })
    .expect(200),
  reply: (message: string, version: number) => request(ctx.app)
    .post(`/api/v1/conversations/${conversationId}/reply`)
    .set(adminSessionHeaders(session))
    .send({ message, expectedVersion: version })
    .expect(201),
  handBack: (version: number) => request(ctx.app)
    .post(`/api/v1/conversations/${conversationId}/handback`)
    .set(adminSessionHeaders(session))
    .send({ expectedVersion: version })
    .expect(200),
});

export const issueConverseGrant = async (ctx: A2aTestApp, agent: { id: string; workspaceId: string }) => {
  const issued = await ctx.dependencies.accessGrantService.issueGrant({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    principalKind: "agent-api",
    channel: "mcp-converse",
    originConstraint: { mode: "allow-all", origins: [] },
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return { token: issued.token, grantId: issued.grant.id };
};

interface RpcOptions {
  /** `null` sends no `A2A-Version` header. */
  version?: string | null;
  bearer?: string;
  extensions?: string;
  id?: string | number;
}

export const rpc = (ctx: A2aTestApp, publicId: string, method: string, params: Record<string, unknown>, options: RpcOptions = {}) => {
  let call = request(ctx.app).post(`/a2a/${publicId}`).set("Content-Type", "application/json");
  if (options.version !== null) call = call.set("A2A-Version", options.version ?? "1.0");
  if (options.bearer) call = call.set("Authorization", `Bearer ${options.bearer}`);
  if (options.extensions) call = call.set("A2A-Extensions", options.extensions);
  return call.send({ jsonrpc: "2.0", id: options.id ?? "req-1", method, params });
};

let messageCounter = 0;

/** A `SendMessage` of one text part; `message` adds `contextId`, `taskId`, or a fixed `messageId`. */
export const sendText = (
  ctx: A2aTestApp,
  publicId: string,
  text: string,
  message: Record<string, unknown> = {},
  options: RpcOptions & { configuration?: Record<string, unknown> } = {},
) => {
  messageCounter += 1;
  return rpc(ctx, publicId, "SendMessage", {
    message: { messageId: `msg-${messageCounter}`, role: "ROLE_USER", parts: [{ text }], ...message },
    ...(options.configuration ? { configuration: options.configuration } : {}),
  }, options);
};

/** The conversation a context id names, read with the key the test app seals contexts under. */
export const conversationIdForContext = async (ctx: A2aTestApp, contextId: string): Promise<string> => {
  const opening = createA2aContextSealer(TEST_FIELD_ENCRYPTION_KEY).open(contextId);
  if (!opening) throw new Error("context id did not open");
  const page = await ctx.repositories.conversationRepository.listPageByAnonymousSession(
    opening.workspaceId,
    opening.publicSessionId,
    { limit: 1, agentId: opening.agentId },
  );
  const conversation = page.conversations[0];
  if (!conversation) throw new Error("context has no conversation yet");
  return conversation.id;
};
