import { describe, expect, it } from "vitest";

import type { RoutineAwaitingDecision } from "@radioso/conversation-contract";

import { buildRoutinePendingDecisionTransition } from "../../src/modules/chat/services/chatService.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = (): PreparedSession =>
  ({
    agent: { id: "agent_1", name: "Support" },
    conversation: { id: "conv_1", workspaceId: "workspace_1" },
  } as PreparedSession);

const awaitingDecision = (): RoutineAwaitingDecision => ({
  stepId: "approval_gate",
  captureKey: "approval_decision",
  reason: "Needs human review.",
  options: [
    { id: "approve", label: "Approve", payload: { internal: "drop" } },
    { id: "reject", label: "Reject", description: "Decline it." },
  ],
});

describe("buildRoutinePendingDecisionTransition", () => {
  it("maps a suspended routine approval signal into a pending decision transition", () => {
    const transition = buildRoutinePendingDecisionTransition({
      session: session(),
      awaitingDecision: awaitingDecision(),
      routineStateTransition: {
        kind: "save",
        state: {
          sessionId: "conv_1",
          routineId: "routine_refund",
          path: ["collect", "approval_gate"],
          variables: {},
          status: "suspended",
        },
      },
    });

    expect(transition).toMatchObject({
      conversationId: "conv_1",
      sessionId: "conv_1",
      workspaceId: "workspace_1",
      agentId: "agent_1",
      routineId: "routine_refund",
      stepId: "approval_gate",
      reason: "Needs human review.",
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject", description: "Decline it." },
      ],
      deciderScope: { kind: "workspace_member" },
    });
    expect(transition?.handle).toMatch(/^pd_[0-9a-f-]{36}$/);
    // buildPendingDecisionTransition carries option payloads through so the operator's choice can
    // be routed back into the routine (see decision-proposal.test.ts, the authoritative contract).
    expect(transition?.options[0]).toMatchObject({ payload: { internal: "drop" } });
  });

  it("fails closed if the engine reports a decision without saving a suspended state", () => {
    expect(() => buildRoutinePendingDecisionTransition({
      session: session(),
      awaitingDecision: awaitingDecision(),
      routineStateTransition: {
        kind: "save",
        state: {
          sessionId: "conv_1",
          routineId: "routine_refund",
          path: ["collect"],
          variables: {},
          status: "active",
        },
      },
    })).toThrow("routine_awaiting_decision_without_suspended_state");
  });
});
