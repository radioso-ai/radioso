import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationRoutineStepRenderer,
  ProcessTurnInput,
  RoutineState,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import { RoutineNextStepSelector } from "@radioso/conversation-defaults";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { routineEndingEffectsForTurn } from "../../src/modules/chat/services/routineEndingEffects.js";
import {
  COMPLETION_NOTIFY_ACTION_TYPE,
  HANDOFF_NOTIFY_ACTION_TYPE,
} from "../../src/modules/chat/services/routines/contactRoutine.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../src/modules/routines/public.js";

const session = {
  conversation: { id: "conv_1" },
  agent: { id: "agent_1" },
  userMessage: { id: "message_1" },
} as unknown as PreparedSession;

const existingAction = { type: "webhook.send", payload: { destinationRef: "dest_1" } };

describe("routineEndingEffectsForTurn", () => {
  it("queues completion.notify for a completion with a notice and leaves ownership alone", () => {
    const effects = routineEndingEffectsForTurn({
      session,
      workspaceId: "ws_1",
      turn: {
        actions: [existingAction],
        operatorNotice: {
          routineId: "routine_1",
          stepId: "done",
          terminalKind: "complete",
          collected: { name: "Ada" },
          subject: "Booking: {{slot.name}}",
        },
      },
    });

    expect(effects.ownershipHandoff).toBeNull();
    expect(effects.actions).toEqual([
      existingAction,
      {
        type: COMPLETION_NOTIFY_ACTION_TYPE,
        payload: {
          conversationId: "conv_1",
          workspaceId: "ws_1",
          agentId: "agent_1",
          userMessageId: "message_1",
          reason: "routine_completed",
          routineId: "routine_1",
          stepId: "done",
          collected: { name: "Ada" },
          notice: { subject: "Booking: {{slot.name}}" },
        },
      },
    ]);
  });

  it("hands the conversation off and queues handoff.notify for a hand-off ending", () => {
    const effects = routineEndingEffectsForTurn({
      session,
      workspaceId: "ws_1",
      turn: {
        handoff: { routineId: "routine_1", stepId: "human", collected: { name: "Ada" } },
        operatorNotice: { routineId: "routine_1", stepId: "human", terminalKind: "handoff", collected: { name: "Ada" } },
      },
    });

    expect(effects.ownershipHandoff).toEqual({ reason: "routine_handoff", routineId: "routine_1", stepId: "human" });
    expect(effects.actions).toEqual([{
      type: HANDOFF_NOTIFY_ACTION_TYPE,
      payload: {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        agentId: "agent_1",
        userMessageId: "message_1",
        reason: "routine_handoff",
        routineId: "routine_1",
        stepId: "human",
        collected: { name: "Ada" },
      },
    }]);
  });

  it("still queues handoff.notify, with the default notice, for a hand-off reported without an operator notice", () => {
    const effects = routineEndingEffectsForTurn({
      session,
      workspaceId: "ws_1",
      turn: {
        actions: [existingAction],
        handoff: { routineId: "routine_1", stepId: "human", collected: { name: "Ada" } },
      },
    });

    expect(effects.ownershipHandoff).toEqual({ reason: "routine_handoff", routineId: "routine_1", stepId: "human" });
    expect(effects.actions).toEqual([
      existingAction,
      {
        type: HANDOFF_NOTIFY_ACTION_TYPE,
        payload: {
          conversationId: "conv_1",
          workspaceId: "ws_1",
          agentId: "agent_1",
          userMessageId: "message_1",
          reason: "routine_handoff",
          routineId: "routine_1",
          stepId: "human",
          collected: { name: "Ada" },
        },
      },
    ]);
  });

  // The outbox idempotency key hashes the serialized payload, so a hand-off without authored
  // notice text must queue exactly the bytes it queued before endings could carry a notice:
  // same keys, same order, no `notice` key.
  describe("a hand-off without authored notice text queues the payload it always has", () => {
    const preNoticePayload = (collected?: Record<string, unknown>) => JSON.stringify({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      userMessageId: "message_1",
      reason: "routine_handoff",
      routineId: "routine_1",
      stepId: "human",
      ...(collected ? { collected } : {}),
    });
    const queuedPayload = (turn: Parameters<typeof routineEndingEffectsForTurn>[0]["turn"]) =>
      JSON.stringify(routineEndingEffectsForTurn({ session, workspaceId: "ws_1", turn }).actions?.at(-1)?.payload);

    it.each([
      ["reported with an empty notice", { handoff: { routineId: "routine_1", stepId: "human", collected: { name: "Ada", nights: 3 } }, operatorNotice: { routineId: "routine_1", stepId: "human", terminalKind: "handoff" as const, collected: { name: "Ada", nights: 3 } } }],
      ["reported without a notice", { handoff: { routineId: "routine_1", stepId: "human", collected: { name: "Ada", nights: 3 } } }],
    ])("%s", (_label, turn) => {
      expect(queuedPayload(turn)).toBe(
        '{"conversationId":"conv_1","workspaceId":"ws_1","agentId":"agent_1","userMessageId":"message_1","reason":"routine_handoff","routineId":"routine_1","stepId":"human","collected":{"name":"Ada","nights":3}}',
      );
      expect(queuedPayload(turn)).toBe(preNoticePayload({ name: "Ada", nights: 3 }));
    });

    it("with nothing collected", () => {
      expect(queuedPayload({ handoff: { routineId: "routine_1", stepId: "human" } })).toBe(preNoticePayload());
      expect(queuedPayload({
        handoff: { routineId: "routine_1", stepId: "human" },
        operatorNotice: { routineId: "routine_1", stepId: "human", terminalKind: "handoff" },
      })).toBe(preNoticePayload());
    });
  });

  it("changes nothing when the turn ended no routine", () => {
    expect(routineEndingEffectsForTurn({ session, workspaceId: "ws_1", turn: { actions: [existingAction] } }))
      .toEqual({ ownershipHandoff: null, actions: [existingAction] });
  });
});

/**
 * A routine stored before endings could carry a notice — a hand-off terminal with no
 * `operatorNotice` — run through the real compiler, runner, and engine, must still hand the
 * conversation off and queue the hand-off notice it always queued.
 */
describe("a stored hand-off without a notice, from definition to effects", () => {
  const now = new Date("2026-10-01T00:00:00.000Z");
  const stored: RoutineDefinition = {
    id: "routine_1",
    agentId: "agent_1",
    lineageId: "lineage_1",
    version: 1,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    name: "Book accommodation",
    activation: { triggerDescription: "the guest wants to book a stay", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
    slots: [
      { stableSlotId: "slot_guest_name", key: "guest_name", type: "text", required: true, description: "The guest's name.", ordinal: 0 },
    ],
    steps: [{
      stableStepId: "ask_name",
      kind: "chat",
      instruction: "Ask for the guest's name: {{slot.guest_name}}",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: {},
    }],
    transitions: [
      { fromStep: "ask_name", toRef: "reception", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
    ],
    terminals: [{ stableStepId: "reception", kind: "handoff", instruction: null, ordinal: 0 }],
  };

  const renderer: ConversationRoutineStepRenderer = {
    render: vi.fn(async ({ step }) => ({ answer: `[${step.id}]`, metadata: {} })),
  };

  it("hands the conversation off and queues handoff.notify", async () => {
    const compiled = compileRoutineDefinition(stored);
    // The selector's verdict on the guest's reply: the name is given, so the step's edge fires.
    const selectorModel: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: '{"claimsAuthority": false, "condition": 1, "variables": {"guest_name": "Ada Lovelace"}}' })),
    };
    const active: RoutineState = { sessionId: "s1", routineId: compiled.id, path: ["ask_name"], variables: {}, status: "active" };
    const input: ProcessTurnInput = {
      agent: { id: "agent_1", name: "Retreat desk" },
      sessionId: "s1",
      inputEvent: { id: "message_1", kind: "message", content: "Ada Lovelace" },
      skills: [],
      directives: [],
      stores: { loadHistory: vi.fn(async () => []), appendEvent: vi.fn(async () => {}) },
      modelGateway: { complete: vi.fn() },
      dispatcher: { dispatch: vi.fn() },
      directiveMatcher: { match: vi.fn(async () => []) },
      selector: { select: vi.fn(async () => ({ selected: [], reason: "none" })) },
      composer: { compose: vi.fn(async () => ({ answer: "", metadata: {} })) },
      routineStore: { loadActive: vi.fn(async () => active), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
      routineRunner: new DefaultRoutineRunner([compiled], new RoutineNextStepSelector(selectorModel), renderer),
    };

    const result = await new DefaultConversationEngine().processTurn(input);
    const effects = routineEndingEffectsForTurn({ session, workspaceId: "ws_1", turn: result });

    expect(result.handoff).toMatchObject({ routineId: compiled.id, stepId: "reception" });
    expect(effects.ownershipHandoff).toEqual({ reason: "routine_handoff", routineId: compiled.id, stepId: "reception" });
    expect(effects.actions?.map((action) => action.type)).toEqual([HANDOFF_NOTIFY_ACTION_TYPE]);
    expect(JSON.stringify(effects.actions?.[0]?.payload)).toBe(JSON.stringify({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      userMessageId: "message_1",
      reason: "routine_handoff",
      routineId: compiled.id,
      stepId: "reception",
      collected: { guest_name: "Ada Lovelace" },
    }));
  });
});
