import { describe, expect, it } from "vitest";

import { compileRoutineDefinition } from "../../src/modules/routines/compiler.js";
import { routineDefinitionDraftInputSchema, type RoutineDefinition, type RoutineDefinitionDraftInput } from "../../src/modules/routines/domain.js";
import { validateRoutineDefinition } from "../../src/modules/routines/validator.js";

const approvalDraft = (): RoutineDefinitionDraftInput => ({
  name: "refund approval",
  activation: {
    triggerDescription: "The user asks for a refund that needs human approval.",
    gateRef: null,
    priority: 10,
  },
  slots: [],
  steps: [
    {
      stableStepId: "request_approval",
      kind: "approval",
      instruction: "Tell the user the refund is waiting for human review.",
      toolRef: null,
      actionType: null,
      captureKey: "refund_decision",
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Reject", description: "Decline the refund request." },
      ],
      ordinal: 0,
      metadata: {},
    },
    {
      stableStepId: "issue_refund",
      kind: "action",
      instruction: "Issue the approved refund.",
      toolRef: null,
      actionType: "refund.issue",
      ordinal: 1,
      metadata: {},
    },
  ],
  transitions: [
    {
      fromStep: "request_approval",
      toRef: "issue_refund",
      guardKind: "field",
      guardText: null,
      fieldRef: "refund_decision.id",
      fieldOp: "equals",
      fieldValue: "approve",
      ordinal: 0,
    },
    {
      fromStep: "request_approval",
      toRef: "declined",
      guardKind: "field",
      guardText: null,
      fieldRef: "refund_decision.id",
      fieldOp: "equals",
      fieldValue: "reject",
      ordinal: 1,
    },
    {
      fromStep: "issue_refund",
      toRef: "approved",
      guardKind: "default",
      guardText: null,
      ordinal: 2,
    },
  ],
  terminals: [
    { stableStepId: "approved", kind: "complete", instruction: "Confirm that the refund was approved.", ordinal: 0 },
    { stableStepId: "declined", kind: "complete", instruction: "Confirm that the refund was declined.", ordinal: 1 },
  ],
});

const approvalDefinition = (): RoutineDefinition => ({
  ...approvalDraft(),
  id: "def_refund_approval",
  agentId: "agent_1",
  lineageId: "lineage_1",
  version: 1,
  status: "published",
  createdAt: new Date("2026-06-17T00:00:00.000Z"),
  updatedAt: new Date("2026-06-17T00:00:00.000Z"),
});

describe("routine approval authoring", () => {
  it("compiles an authored approval gate to a runtime await step with deterministic decision edges", () => {
    const definition = approvalDefinition();

    expect(validateRoutineDefinition(definition)).toEqual({ ok: true, diagnostics: [] });

    const routine = compileRoutineDefinition(definition);
    const gate = routine.steps.find((step) => step.id === "request_approval");

    expect(gate).toMatchObject({
      id: "request_approval",
      kind: "await",
      action: "Tell the user the refund is waiting for human review.",
      decision: {
        captureKey: "refund_decision",
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject", description: "Decline the refund request." },
        ],
      },
      metadata: { authoredKind: "approval" },
    });
    expect(gate?.metadata).not.toHaveProperty("collectsSlots");
    expect(routine.transitions).toContainEqual({
      from: "request_approval",
      to: "issue_refund",
      condition: "field",
      guard: { kind: "field", ref: "refund_decision.id", op: "equals", value: "approve" },
    });
    expect(routine.transitions).toContainEqual({
      from: "request_approval",
      to: "declined",
      condition: "field",
      guard: { kind: "field", ref: "refund_decision.id", op: "equals", value: "reject" },
    });
  });

  it("rejects approval gates with llm outgoing edges", () => {
    const definition: RoutineDefinition = {
      ...approvalDefinition(),
      transitions: [
        { fromStep: "request_approval", toRef: "issue_refund", guardKind: "llm", guardText: "The reviewer approved the refund.", ordinal: 0 },
        { fromStep: "issue_refund", toRef: "approved", guardKind: "default", guardText: null, ordinal: 1 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "approval_step_llm_edge",
      location: "step:request_approval",
    }));
  });

  it("rejects approval gates with no outgoing decision edge for the capture key", () => {
    const definition: RoutineDefinition = {
      ...approvalDefinition(),
      transitions: [
        { fromStep: "request_approval", toRef: "declined", guardKind: "default", guardText: null, ordinal: 0 },
      ],
    };

    const result = validateRoutineDefinition(definition);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "approval_step_no_decision_edge",
      location: "step:request_approval",
    }));
  });

  it("rejects approval fields on non-approval steps at the schema boundary", () => {
    const draft = approvalDraft();
    const result = routineDefinitionDraftInputSchema.safeParse({
      ...draft,
      steps: [{
        ...draft.steps[0],
        kind: "chat",
        captureKey: "refund_decision",
        options: [{ id: "approve", label: "Approve" }],
      }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects approval steps missing options at the schema boundary", () => {
    const draft = approvalDraft();
    const result = routineDefinitionDraftInputSchema.safeParse({
      ...draft,
      steps: [{
        ...draft.steps[0],
        options: undefined,
      }],
    });

    expect(result.success).toBe(false);
  });
});
