import { describe, expect, it } from "vitest";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { routineEndingEffectsForTurn } from "../../src/modules/chat/services/routineEndingEffects.js";
import {
  COMPLETION_NOTIFY_ACTION_TYPE,
  HANDOFF_NOTIFY_ACTION_TYPE,
} from "../../src/modules/chat/services/routines/contactRoutine.js";

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

  it("changes nothing when the turn ended no routine", () => {
    expect(routineEndingEffectsForTurn({ session, workspaceId: "ws_1", turn: { actions: [existingAction] } }))
      .toEqual({ ownershipHandoff: null, actions: [existingAction] });
  });
});
