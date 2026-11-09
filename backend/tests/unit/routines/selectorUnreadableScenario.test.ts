import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelCompletion,
  ConversationModelGateway,
  ConversationModelRequest,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import { compileRoutineDefinition } from "../../../src/modules/routines/public.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";
import { createRoutineTurnProvider } from "../../../src/modules/routines/turnProvider.js";

/**
 * #1715 through the routine pipeline a conversation runs: the real compiler, the turn provider's
 * selector and step renderer with the shipped prompt templates, and the runner. In production a
 * contact step collecting a full name and an email read a complete answer as unreadable twice —
 * both decision completions came back blank, the provider reporting they finished normally — so
 * the answer was lost and the step asked for the name again with no reason given.
 */

const now = new Date("2026-11-09T00:00:00.000Z");

const authored: RoutineDefinition = {
  id: "routine:agent_1:booking:v1",
  agentId: "agent-1",
  lineageId: "lineage_1",
  version: 1,
  enabled: true,
  createdAt: now,
  updatedAt: now,
  name: "Book a course",
  activation: { triggerDescription: "the user wants to book a course", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_full_name", key: "full_name", type: "text", required: true, description: "Their first and last name.", ordinal: 0 },
    { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: "Where the team confirms the booking.", ordinal: 1 },
  ],
  steps: [
    {
      stableStepId: "contact",
      kind: "chat",
      instruction: "Thank them, then ask for their full name {{slot.full_name}} and email address {{slot.email}}.",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: {},
    },
    {
      stableStepId: "recap",
      kind: "chat",
      instruction: "Read back {{slot.full_name}} and {{slot.email}} and ask them to confirm.",
      toolRef: null,
      actionType: null,
      ordinal: 1,
      metadata: {},
    },
  ],
  transitions: [
    { fromStep: "contact", toRef: "recap", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
    { fromStep: "recap", toRef: "done", guardKind: "llm", guardText: "The user confirms the details.", outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 1 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the request was sent.", ordinal: 0 }],
};

const routine = compileRoutineDefinition(authored);

const turn: TurnContext = {
  agent: { id: "agent-1", name: "Booking Desk" },
  sessionId: "conversation-1",
  inputEvent: { id: "message-2", kind: "message", content: "Alex Rivera, alex.rivera@example.com" },
  history: [
    { role: "user", content: "I'd like to book the pottery weekend" },
    { role: "assistant", content: "Lovely! What are your full name and email address?" },
  ],
  stagedContext: [],
  steering: [],
};

const contactState: RoutineState = { sessionId: turn.sessionId, routineId: routine.id, path: ["contact"], variables: {}, status: "active" };

const dependencies = () => ({
  agentSkillRepository: { listByAgent: vi.fn(async () => []) },
  capabilityPolicy: { can: vi.fn(async () => ({ allowed: true })) },
  clusteringEmbeddings: {},
  embeddingModelForWorkspace: vi.fn(async () => "unused"),
  logger: { debug: vi.fn(), warn: vi.fn() },
  metricsRegistry: { incrementCounter: vi.fn() },
  publishedRoutineSource: {
    load: vi.fn(async (): Promise<RoutineRegistration[]> => [{ routine, trigger: { description: "Book a course", priority: 1 } }]),
    loadPinned: vi.fn(async (): Promise<RoutineRegistration[]> => []),
    loadPreview: vi.fn(async (): Promise<RoutineRegistration[]> => []),
  },
  routineDefinitionRepository: {},
  routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) },
  routineRegistrations: [],
  routineTriggerEmbeddingService: { persistPublished: vi.fn() },
  skillExecutorRegistry: {},
  turnPlanAdapters: {
    activator: ({ fallback }: { fallback: unknown }) => fallback,
    reentryGate: ({ fallback }: { fallback: unknown }) => fallback,
    slotCorrection: ({ fallback }: { fallback: unknown }) => fallback,
  },
});

/**
 * The model, answering each routine call by the prompt it was sent: the selector's decision (the
 * prompt that asks for `claimsAuthority`), the selector's slot-only reading, or a step reply.
 */
const modelAnswering = (answers: { decision: ConversationModelCompletion; slotFallback: ConversationModelCompletion }) => {
  const replies: ConversationModelRequest[] = [];
  const calls: string[] = [];
  const gateway: ConversationModelGateway = {
    complete: vi.fn(async (request: ConversationModelRequest) => {
      const systemPrompt = request.systemPrompt ?? "";
      if (systemPrompt.includes('"claimsAuthority"')) {
        calls.push("decision");
        return answers.decision;
      }
      if (systemPrompt.startsWith("Record the slot values")) {
        calls.push("slot_fallback");
        return answers.slotFallback;
      }
      calls.push("reply");
      replies.push(request);
      return { text: "A reply the model wrote." };
    }),
  };
  return { gateway, calls, replies };
};

// The shape observed in production: no text at all, and a provider that says it finished normally.
const blank: ConversationModelCompletion = { text: "", stopReason: "completed", model: "gpt-5.4-mini" };

describe("a contact step whose decision comes back unreadable twice (#1715)", () => {
  it("keeps the name and email the visitor gave and moves on to the next step", async () => {
    const deps = dependencies();
    const model = modelAnswering({
      decision: blank,
      slotFallback: { text: '{"variables": {"full_name": "Alex Rivera", "email": "alex.rivera@example.com"}}', model: "gpt-5.4-mini" },
    });
    const ports = await createRoutineTurnProvider(deps as never).forTurn({ modelGateway: model.gateway, agentId: "agent-1", workspaceId: "workspace-1" });

    const result = await ports!.runner.resume({ turn, state: contactState });

    expect(model.calls).toEqual(["decision", "decision", "slot_fallback", "reply"]);
    expect(result.nextState).toMatchObject({
      path: ["contact", "recap"],
      variables: { full_name: "Alex Rivera", email: "alex.rivera@example.com" },
    });
    expect(result.trace?.capturedSlotKeys).toEqual(["full_name", "email"]);
    expect(result.trace?.steps[0]).toMatchObject({
      stepId: "contact",
      event: "advanced",
      selection: { outcome: "unreadable", unreadableReason: "no_json_object", retried: true, slotFallback: "read" },
    });
    // The next step's reply is not a re-ask of the contact step.
    expect(model.replies[0]?.systemPrompt).not.toContain("asks again");
  });

  it("re-asks without suggesting the answer fell short when the slot-only reading is unreadable too", async () => {
    const deps = dependencies();
    const model = modelAnswering({ decision: blank, slotFallback: blank });
    const ports = await createRoutineTurnProvider(deps as never).forTurn({ modelGateway: model.gateway, agentId: "agent-1", workspaceId: "workspace-1" });

    const result = await ports!.runner.resume({ turn, state: contactState });

    expect(model.calls).toEqual(["decision", "decision", "slot_fallback", "reply"]);
    expect(result.nextState).toMatchObject({ path: ["contact"], variables: {} });
    const replyPrompt = model.replies[0]?.systemPrompt ?? "";
    expect(replyPrompt).toContain("could not be recorded");
    expect(replyPrompt).not.toContain("did not give everything this step needs");
    expect(replyPrompt).toContain("Still to ask for: full_name, email.");
  });

  it("counts each completion by model, step kind, call and result, and logs the unreadable ones without the visitor's words", async () => {
    const deps = dependencies();
    const model = modelAnswering({
      decision: blank,
      slotFallback: { text: '{"variables": {"full_name": "Alex Rivera", "email": "alex.rivera@example.com"}}', model: "gpt-5.4-mini" },
    });
    const ports = await createRoutineTurnProvider(deps as never).forTurn({ modelGateway: model.gateway, agentId: "agent-1", workspaceId: "workspace-1" });

    await ports!.runner.resume({ turn, state: contactState });

    const completions = deps.metricsRegistry.incrementCounter.mock.calls
      .filter(([name]) => name === "routine_next_step_completions_total")
      .map(([, options]) => (options as { labels: Record<string, string> }).labels);
    expect(completions).toEqual([
      { model: "gpt-5.4-mini", step_kind: "chat", call: "decision", result: "no_json_object" },
      { model: "gpt-5.4-mini", step_kind: "chat", call: "retry", result: "no_json_object" },
      { model: "gpt-5.4-mini", step_kind: "chat", call: "slot_fallback", result: "read" },
    ]);
    const unreadableWarnings = deps.logger.warn.mock.calls.filter(([, message]) => message === "Routine next-step decision was unreadable");
    expect(unreadableWarnings.map(([fields]) => (fields as { call: string }).call)).toEqual(["decision", "retry"]);
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain("alex.rivera@example.com");
    expect(JSON.stringify(deps.metricsRegistry.incrementCounter.mock.calls)).not.toContain("Alex Rivera");
  });
});
