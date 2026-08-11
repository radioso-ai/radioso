import { describe, expect, it } from "vitest";

import {
  routineDefinitionDraftEditingInputSchema,
  routineIdentifierPattern,
  routineDefinitionDraftInputSchema,
  routineGuardProvenance,
  routineInputBindingSchema,
  routineSlotSchema,
  routineStepSchema,
  routineTerminalSchema,
  routineTransitionSchema,
} from "../src/index.js";

const validSlot = {
  stableSlotId: "email",
  key: "email",
  type: "email",
  required: true,
  description: "Customer email",
  ordinal: 0,
} as const;

const validStep = {
  stableStepId: "lookup",
  kind: "tool",
  instruction: "Look up the order",
  toolRef: "order_lookup",
  actionType: null,
  captureKey: null,
  ordinal: 0,
  metadata: {
    inputBindings: {
      email: { kind: "variableRef", ref: "email" },
      locale: { kind: "contextVariableRef", contextVariable: "page_locale" },
    },
    outputAssignments: { status: "order_status" },
    mode: "typed",
  },
} as const;

const validTerminal = {
  stableStepId: "done",
  kind: "complete",
  instruction: null,
  ordinal: 0,
} as const;

describe("routine definition schemas", () => {
  it("exports the stable identifier grammar used by route ids", () => {
    expect(routineIdentifierPattern.test("ineligible-case")).toBe(true);
    expect(routineIdentifierPattern.test("v2.flow-check")).toBe(true);
    expect(routineIdentifierPattern.test("-bad")).toBe(false);
  });

  it("accepts a complete draft input with context variable bindings", () => {
    const result = routineDefinitionDraftInputSchema.safeParse({
      name: "Order support",
      activation: {
        triggerDescription: "When a customer asks about an order",
        gateRef: null,
        priority: 0,
        reentryMode: "once_per_conversation",
      },
      slots: [validSlot],
      steps: [validStep],
      transitions: [{
        fromStep: "lookup",
        toRef: "done",
        guardKind: "outcome",
        guardText: null,
        outcomeStatus: "success",
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [validTerminal],
      completionExport: {
        enabled: true,
        triggerKinds: ["complete"],
        destinationRef: "crm.case",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts mid-edit drafts without weakening persistence validation", () => {
    const baseDraft = {
      name: "Order support",
      activation: { triggerDescription: "When a customer asks about an order", gateRef: null, priority: 0 },
      slots: [],
      transitions: [],
      terminals: [validTerminal],
    };
    const midEditDrafts = [
      {
        ...baseDraft,
        steps: [{ stableStepId: "chat", kind: "chat", instruction: "", toolRef: null, actionType: null, captureKey: null, options: [], ordinal: 0, metadata: {} }],
      },
      {
        ...baseDraft,
        activation: { ...baseDraft.activation, triggerDescription: "" },
        steps: [validStep],
      },
      {
        ...baseDraft,
        steps: [{ stableStepId: "approve", kind: "approval", instruction: "Approve the refund", toolRef: null, actionType: null, captureKey: null, options: [], ordinal: 0, metadata: {} }],
      },
      {
        ...baseDraft,
        steps: [{ stableStepId: "select-tool", kind: "tool", instruction: "Look up the order", toolRef: null, actionType: null, captureKey: null, options: [], ordinal: 0, metadata: {} }],
      },
    ];

    for (const draft of midEditDrafts) {
      expect(routineDefinitionDraftEditingInputSchema.safeParse(draft).success).toBe(true);
      expect(routineDefinitionDraftInputSchema.safeParse(draft).success).toBe(false);
    }
  });

  it("accepts empty optional content fields only in the editing schema", () => {
    const baseDraft = {
      name: "Order support",
      activation: { triggerDescription: "When a customer asks about an order", gateRef: null, priority: 0 },
      slots: [],
      steps: [validStep],
      transitions: [],
      terminals: [validTerminal],
    };
    const emptyFieldDrafts = [
      {
        field: "terminals[].instruction",
        draft: { ...baseDraft, terminals: [{ ...validTerminal, instruction: "" }] },
      },
      {
        field: "transitions[].guardText",
        draft: {
          ...baseDraft,
          transitions: [{ fromStep: "lookup", toRef: "done", guardKind: "default", guardText: "", outcomeStatus: null, counterLimit: null, ordinal: 0 }],
        },
      },
      {
        field: "transitions[].outcomeStatus",
        draft: {
          ...baseDraft,
          transitions: [{ fromStep: "lookup", toRef: "done", guardKind: "outcome", guardText: null, outcomeStatus: "", counterLimit: null, ordinal: 0 }],
        },
      },
      {
        field: "slots[].description",
        draft: { ...baseDraft, slots: [{ ...validSlot, description: "" }] },
      },
      {
        field: "steps[].options[].description",
        draft: {
          ...baseDraft,
          steps: [{
            stableStepId: "approve",
            kind: "approval",
            instruction: "Approve the refund",
            toolRef: null,
            actionType: null,
            captureKey: "decision",
            options: [{ id: "yes", label: "Yes", description: "" }, { id: "no", label: "No", description: null }],
            ordinal: 0,
            metadata: {},
          }],
        },
      },
    ];

    for (const { field, draft } of emptyFieldDrafts) {
      expect(routineDefinitionDraftEditingInputSchema.safeParse(draft).success, field).toBe(true);
      expect(routineDefinitionDraftInputSchema.safeParse(draft).success, field).toBe(false);
    }
  });

  it("rejects invalid slot keys", () => {
    expect(routineSlotSchema.safeParse({ ...validSlot, key: "bad-key" }).success).toBe(false);
  });

  it("rejects approval steps without choices", () => {
    expect(routineStepSchema.safeParse({
      stableStepId: "approve",
      kind: "approval",
      instruction: "Approve the refund",
      toolRef: null,
      actionType: null,
      captureKey: "decision",
      options: [{ id: "yes", label: "Yes", description: null }],
      ordinal: 0,
      metadata: {},
    }).success).toBe(false);
  });

  it("rejects malformed context variable bindings", () => {
    expect(routineInputBindingSchema.safeParse({
      kind: "contextVariableRef",
      contextVariable: "bad key",
    }).success).toBe(false);
  });

  it("rejects incomplete field guards", () => {
    expect(routineTransitionSchema.safeParse({
      fromStep: "lookup",
      toRef: "done",
      guardKind: "field",
      guardText: null,
      outcomeStatus: null,
      counterLimit: null,
      fieldRef: "status",
      fieldOp: "unknown",
      ordinal: 0,
    }).success).toBe(false);
  });

  it("rejects invalid terminal kinds", () => {
    expect(routineTerminalSchema.safeParse({ ...validTerminal, kind: "pause" }).success).toBe(false);
  });

  it("classifies guard provenance", () => {
    expect(routineGuardProvenance("llm")).toBe("judgment");
    expect(routineGuardProvenance("field")).toBe("exact");
  });
});
