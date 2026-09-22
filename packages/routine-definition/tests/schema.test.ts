import { describe, expect, it } from "vitest";

import {
  collectContextVariableRefs,
  ROUTINE_DEFINITION_LIMITS,
  routineDefinitionDraftEditingInputSchema,
  routineDefinitionDraftUpdateInputSchema,
  routineDefinitionSchema,
  routineExposureSchema,
  routineExposureToolNamePattern,
  routineIdentifierPattern,
  routineDefinitionDraftInputSchema,
  routineGuardProvenance,
  routineInputBindingSchema,
  routineValidationCodes,
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
  it("validates optional activation coverage criteria while preserving legacy activation", () => {
    const base = {
      name: "Coverage follow-up",
      activation: { triggerDescription: "When evidence is incomplete", gateRef: null, priority: 0 },
      slots: [], steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask a follow-up.", toolRef: null, actionType: null, captureKey: null, ordinal: 0, metadata: {} }],
      transitions: [], terminals: [validTerminal],
    };
    expect(routineDefinitionDraftInputSchema.parse({
      ...base,
      activation: { ...base.activation, coverageCriteria: { coverage: ["unanswered"], reasons: ["insufficient_evidence"] } },
    }).activation.coverageCriteria).toEqual({ coverage: ["unanswered"], reasons: ["insufficient_evidence"] });
    expect(routineDefinitionDraftInputSchema.parse(base).activation.coverageCriteria).toBeUndefined();
    expect(routineDefinitionDraftInputSchema.safeParse({ ...base, activation: { ...base.activation, coverageCriteria: { coverage: [] } } }).success).toBe(false);
  });

  it("rejects duplicate or incompatible coverage criteria so authoring matches runtime validation", () => {
    const base = {
      name: "Coverage follow-up",
      activation: { triggerDescription: "When evidence is incomplete", gateRef: null, priority: 0 },
      slots: [], steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask a follow-up.", toolRef: null, actionType: null, captureKey: null, ordinal: 0, metadata: {} }],
      transitions: [], terminals: [validTerminal],
    };

    expect(routineDefinitionDraftInputSchema.safeParse({
      ...base,
      activation: { ...base.activation, coverageCriteria: { coverage: ["unanswered", "unanswered"] } },
    }).success).toBe(false);
    expect(routineDefinitionDraftInputSchema.safeParse({
      ...base,
      activation: { ...base.activation, coverageCriteria: { coverage: ["unclear"], reasons: ["insufficient_evidence"] } },
    }).success).toBe(false);
    expect(routineDefinitionDraftInputSchema.safeParse({
      ...base,
      activation: { ...base.activation, coverageCriteria: { coverage: ["unanswered"], reasons: ["insufficient_evidence", "insufficient_evidence"] } },
    }).success).toBe(false);
  });
  it("exports the validation-code vocabulary used by routine hosts", () => {
    expect(routineValidationCodes).toContain("unknown_context_variable");
    expect(routineValidationCodes).toContain("node_id_collision");
  });

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

describe("collectContextVariableRefs", () => {
  it("extracts distinct {{context.<name>}} references in first-seen order", () => {
    expect(collectContextVariableRefs(
      "If {{context.page_context}} names a program, confirm it; else ask. Also {{ context.cart }} and {{context.page_context}}.",
    )).toEqual(["page_context", "cart"]);
  });

  it("returns an empty list when the instruction references no context variable", () => {
    expect(collectContextVariableRefs("Ask for {{slot.name}}.")).toEqual([]);
  });
});

describe("routine exposure", () => {
  const draft = {
    name: "Start a return",
    activation: { triggerDescription: "A customer wants to return an order", gateRef: null, priority: 0 },
    slots: [],
    steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask for the order number.", toolRef: null, actionType: null, captureKey: null, ordinal: 0, metadata: {} }],
    transitions: [],
    terminals: [validTerminal],
  };

  it("names the tool-name grammar every exposure host validates against", () => {
    for (const accepted of ["start_return", "a1", "request_callback", `a${"b".repeat(62)}`]) {
      expect(routineExposureToolNamePattern.test(accepted), accepted).toBe(true);
    }
    for (const rejected of ["", "a", "Start_return", "1start", "start-return", "start return", "_start", `a${"b".repeat(63)}`]) {
      expect(routineExposureToolNamePattern.test(rejected), rejected).toBe(false);
    }
  });

  it("is optional on every routine schema: an absent block reads back absent", () => {
    expect(routineDefinitionDraftInputSchema.parse(draft).exposure).toBeUndefined();
    expect(routineDefinitionDraftEditingInputSchema.parse(draft).exposure).toBeUndefined();
    expect(routineDefinitionDraftUpdateInputSchema.parse(draft).exposure).toBeUndefined();
    expect(routineDefinitionSchema.parse({
      ...draft, id: "r1", agentId: "a1", lineageId: "l1", version: 1, createdAt: new Date(), updatedAt: new Date(),
    }).exposure).toBeUndefined();
  });

  it("carries the block through the draft, editing, and definition schemas", () => {
    const exposure = { enabled: true, toolName: "start_return", description: "Start a return for an order." };
    expect(routineDefinitionDraftInputSchema.parse({ ...draft, exposure }).exposure).toEqual(exposure);
    expect(routineDefinitionDraftEditingInputSchema.parse({ ...draft, exposure }).exposure).toEqual(exposure);
    expect(routineDefinitionSchema.parse({
      ...draft, exposure, id: "r1", agentId: "a1", lineageId: "l1", version: 1, createdAt: new Date(), updatedAt: new Date(),
    }).exposure).toEqual(exposure);
  });

  it("holds a half-typed name in every schema so the validator can diagnose it rather than the request failing", () => {
    // A draft may carry an invalid tool name the same way it may carry an unreachable step: the
    // routine validator reports it as a diagnostic and publish refuses it. The schema only
    // bounds the shape.
    const exposure = { enabled: true, toolName: "Start return", description: "" };
    expect(routineExposureSchema.parse(exposure)).toEqual(exposure);
    expect(routineDefinitionDraftInputSchema.parse({ ...draft, exposure }).exposure).toEqual(exposure);
  });

  it("trims and bounds the tool name and description", () => {
    expect(routineExposureSchema.parse({ enabled: false, toolName: "  start_return ", description: "  Start a return.  " }))
      .toEqual({ enabled: false, toolName: "start_return", description: "Start a return." });
    expect(routineExposureSchema.safeParse({ enabled: true, toolName: "a".repeat(ROUTINE_DEFINITION_LIMITS.exposureToolName + 1), description: "" }).success).toBe(false);
    expect(routineExposureSchema.safeParse({ enabled: true, toolName: "start_return", description: "d".repeat(ROUTINE_DEFINITION_LIMITS.exposureDescription + 1) }).success).toBe(false);
    expect(routineExposureSchema.safeParse({ enabled: true, toolName: "start_return" }).success).toBe(false);
    expect(routineExposureSchema.safeParse({ toolName: "start_return", description: "" }).success).toBe(false);
    expect(routineExposureSchema.safeParse({ enabled: true, toolName: "start_return", description: "", extra: 1 }).success).toBe(false);
  });

  it("keeps the update schema free of exposure defaults so an omitted block carries the stored one forward", () => {
    const parsed = routineDefinitionDraftUpdateInputSchema.parse({ ...draft, name: "Renamed" });
    expect("exposure" in parsed && parsed.exposure !== undefined).toBe(false);
  });

  it("exports the exposure validation codes routine hosts report", () => {
    for (const code of [
      "exposure_tool_name_invalid",
      "exposure_tool_name_reserved",
      "exposure_tool_name_duplicate",
      "exposure_tool_name_changed",
      "exposure_requires_ungated_activation",
    ]) {
      expect(routineValidationCodes).toContain(code);
    }
  });
});

