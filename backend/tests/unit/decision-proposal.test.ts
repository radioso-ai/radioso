import { describe, expect, it } from "vitest";

import type { RoutineAwaitingDecision } from "@radioso/conversation-contract";
import {
  buildPendingDecisionTransition,
  computeProposalContentHash,
  mintDecisionHandle,
} from "../../src/modules/approvals/public.js";

describe("decision proposal helper", () => {
  it("mints distinct handles that are not derived from the conversation id", () => {
    const conversationId = "conv_123";
    const first = mintDecisionHandle();
    const second = mintDecisionHandle();

    expect(first).not.toEqual(second);
    expect(first).not.toEqual(conversationId);
    expect(second).not.toEqual(conversationId);
    expect(first).toMatch(/^pd_[0-9a-f-]{36}$/);
    expect(second).toMatch(/^pd_[0-9a-f-]{36}$/);
  });

  it("computes stable content hashes for a logical proposal", () => {
    const proposal = {
      routineId: "routine_refund",
      stepId: "manager_review",
      captureKey: "refund_decision",
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject" },
      ],
    };

    const reorderedProposal = {
      options: [
        { label: "Approve", id: "approve" },
        { label: "Reject", id: "reject" },
      ],
      captureKey: "refund_decision",
      stepId: "manager_review",
      routineId: "routine_refund",
    };

    expect(computeProposalContentHash(proposal)).toEqual(computeProposalContentHash(proposal));
    expect(computeProposalContentHash(reorderedProposal)).toEqual(computeProposalContentHash(proposal));
    expect(computeProposalContentHash({ ...proposal, stepId: "finance_review" })).not.toEqual(
      computeProposalContentHash(proposal),
    );
    expect(
      computeProposalContentHash({
        ...proposal,
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject_with_note", label: "Reject" },
        ],
      }),
    ).not.toEqual(computeProposalContentHash(proposal));
    expect(
      computeProposalContentHash({
        ...proposal,
        options: [
          { id: "approve", label: "Approve refund" },
          { id: "reject", label: "Reject" },
        ],
      }),
    ).not.toEqual(computeProposalContentHash(proposal));
  });

  it("maps an awaiting decision signal into a pending decision create input", () => {
    const awaitingDecision: RoutineAwaitingDecision = {
      stepId: "manager_review",
      captureKey: "refund_decision",
      reason: "Refund amount is above the automatic approval limit.",
      options: [
        { id: "approve", label: "Approve", payload: { internalCode: "approve_refund" } },
        {
          id: "reject",
          label: "Reject",
          description: "Decline the refund.",
          payload: { internalCode: "reject_refund" },
        },
      ],
    };
    const deadline = new Date("2026-06-18T12:00:00.000Z");

    const pendingDecision = buildPendingDecisionTransition({
      conversationId: "conv_123",
      sessionId: "session_123",
      workspaceId: "workspace_123",
      agentId: "agent_123",
      routineId: "routine_refund",
      awaitingDecision,
      deadline,
    });

    expect(pendingDecision).toMatchObject({
      conversationId: "conv_123",
      sessionId: "session_123",
      workspaceId: "workspace_123",
      agentId: "agent_123",
      routineId: "routine_refund",
      stepId: "manager_review",
      reason: "Refund amount is above the automatic approval limit.",
      options: [
        { id: "approve", label: "Approve" },
        {
          id: "reject",
          label: "Reject",
          description: "Decline the refund.",
        },
      ],
      deciderScope: { kind: "workspace_member" },
      deadline,
    });
    expect(pendingDecision.handle).toMatch(/^pd_[0-9a-f-]{36}$/);
    expect(pendingDecision.handle).not.toEqual("conv_123");
    expect(pendingDecision.contentHash).toEqual(
      computeProposalContentHash({
        routineId: "routine_refund",
        stepId: "manager_review",
        captureKey: "refund_decision",
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
      }),
    );
  });
});
