import { describe, expect, it } from "vitest";

import type { RoutineDefinition, RoutineDefinitionDraftInput, RoutineDocument, RoutineValidationDiagnostic } from "../../src/modules/routines/public.js";
import {
  compileRoutineDefinition,
  mapRoutineDiagnosticToDocumentRange,
  parseRoutineDocumentFixture,
  routineDocumentToDraft,
  routineDraftToDocument,
  serializeRoutineDocument,
} from "../../src/modules/routines/public.js";

const fullDraft = (): RoutineDefinitionDraftInput => ({
  name: "order-support",
  activation: {
    triggerDescription: "When the visitor needs order support.",
    gateRef: "support.enabled",
    priority: 20,
  },
  slots: [
    { stableSlotId: "email", key: "email", type: "email", required: true, description: "Customer email.", ordinal: 0 },
    { stableSlotId: "order_id", key: "order_id", type: "text", required: false, description: "Order number when known.", ordinal: 1 },
  ],
  steps: [
    {
      stableStepId: "gather",
      kind: "chat",
      instruction: "Ask for {{slot.email}} and optionally {{slot.order_id}}.",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: {},
    },
    {
      stableStepId: "lookup",
      kind: "tool",
      instruction: "Run @order_lookup for {{slot.email}}.",
      toolRef: "order_lookup",
      actionType: null,
      ordinal: 1,
      metadata: {},
    },
    {
      stableStepId: "retry",
      kind: "chat",
      instruction: "Ask for another {{slot.email}}.",
      toolRef: null,
      actionType: null,
      ordinal: 2,
      metadata: {},
    },
    {
      stableStepId: "review",
      kind: "chat",
      instruction: "Ask whether the visitor accepts email updates.",
      toolRef: null,
      actionType: null,
      ordinal: 3,
      metadata: {},
    },
    {
      stableStepId: "notify",
      kind: "action",
      instruction: "Send @ticket_notify.",
      toolRef: null,
      actionType: "ticket_notify",
      ordinal: 4,
      metadata: {},
    },
  ],
  transitions: [
    { fromStep: "gather", toRef: "lookup", guardKind: "slot_filled", guardText: "{{slot.email}}", outcomeStatus: null, counterLimit: null, ordinal: 0 },
    { fromStep: "lookup", toRef: "review", guardKind: "outcome", guardText: null, outcomeStatus: "success", counterLimit: null, ordinal: 1 },
    { fromStep: "lookup", toRef: "retry", guardKind: "outcome", guardText: null, outcomeStatus: "failure", counterLimit: null, ordinal: 2 },
    { fromStep: "lookup", toRef: "handoff_human", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 3 },
    { fromStep: "retry", toRef: "lookup", guardKind: "counter", guardText: null, outcomeStatus: null, counterLimit: 2, ordinal: 4 },
    { fromStep: "retry", toRef: "handoff_human", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 5 },
    { fromStep: "review", toRef: "notify", guardKind: "llm", guardText: "the visitor accepts email updates", outcomeStatus: null, counterLimit: null, ordinal: 6 },
    { fromStep: "notify", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 7 },
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm the order support case is open for {{slot.email}}.", ordinal: 0 },
    { stableStepId: "handoff_human", kind: "handoff", instruction: "Hand the visitor to a human.", ordinal: 1 },
  ],
});

const definitionFromDraft = (draft: RoutineDefinitionDraftInput): RoutineDefinition => ({
  ...draft,
  id: "def_1",
  agentId: "agent_1",
  lineageId: "lineage_1",
  version: 1,
  status: "published",
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
});

describe("routine document model round trips", () => {
  it("round-trips every existing draft guard kind through the document AST", () => {
    const document = routineDraftToDocument(fullDraft());
    const result = routineDocumentToDraft(document);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft).toEqual(fullDraft());
  });

  it("round-trips non-adjacent forward and backward step targets and compiles them unchanged", () => {
    const draft = fullDraft();
    const document = routineDraftToDocument(draft);
    const result = routineDocumentToDraft(document);
    const routine = compileRoutineDefinition(definitionFromDraft(result.draft));

    expect(result.diagnostics).toEqual([]);
    expect(result.draft).toEqual(draft);
    expect(document.sections[0]).toMatchObject({
      kind: "routine",
      steps: expect.arrayContaining([
        expect.objectContaining({
          stableStepId: "lookup",
          branches: expect.arrayContaining([
            expect.objectContaining({ target: { kind: "step", stableId: "review" } }),
          ]),
        }),
        expect.objectContaining({
          stableStepId: "retry",
          branches: expect.arrayContaining([
            expect.objectContaining({ target: { kind: "step", stableId: "lookup" } }),
          ]),
        }),
      ]),
    });
    expect(routine.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "lookup", to: "review" }),
      expect.objectContaining({ from: "retry", to: "lookup" }),
    ]));
  });

  it.each(["done", "handoff"] as const)("rejects a step-target branch that points at reserved terminal id %s", (terminalId) => {
    const document: RoutineDocument = {
      name: "terminal-step-target",
      activation: {
        triggerDescription: "support",
        gateRef: null,
        priority: 1,
      },
      sections: [{
        kind: "routine",
        variables: [],
        steps: [{
          stableStepId: "start",
          label: null,
          instruction: "Start.",
          kind: "chat",
          toolRef: null,
          actionType: null,
          metadata: {},
          ordinal: 0,
          branches: [{
            fromStepId: "start",
            target: { kind: "step", stableId: terminalId },
            guard: { kind: "default" },
            ordinal: 0,
          }],
        }],
        ends: [
          { stableStepId: "done", kind: "complete", instruction: "Done.", ordinal: 0 },
          { stableStepId: "handoff", kind: "handoff", instruction: "Hand off.", ordinal: 1 },
        ],
      }],
    };

    const result = routineDocumentToDraft(document);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid_transition",
      location: `transition:start->${terminalId}`,
      message: expect.stringContaining("use an end target instead"),
    }));
    expect(result.draft.transitions).toEqual([]);
  });

  it("round-trips every existing draft guard kind through fixture text", () => {
    const text = serializeRoutineDocument(routineDraftToDocument(fullDraft()));
    const parsed = parseRoutineDocumentFixture(text, {
      actionNames: ["order_lookup", "ticket_notify"],
      actionKinds: { order_lookup: "tool", ticket_notify: "action" },
    });
    const result = routineDocumentToDraft(parsed.document);

    expect(parsed.diagnostics).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.draft).toEqual(fullDraft());
  });

  it("normalizes legacy always and fallback fixture guard aliases to default", () => {
    const text = `---
name: legacy-defaults
trigger: support
priority: 1
---

## Variables
- email: email - Email address.

## Steps

1. Ask for @email. {#ask}
   -> #done [always]

2. Ask whether they need a human. {#branch}
   if they need help -> #handoff
   -> #done [fallback]

## Ends
- done [complete]: Done for @email.
- handoff [handoff]: Hand off.
`;

    const result = routineDocumentToDraft(parseRoutineDocumentFixture(text).document);

    expect(result.draft.transitions).toEqual([
      expect.objectContaining({ fromStep: "ask", toRef: "done", guardKind: "default" }),
      expect.objectContaining({ fromStep: "branch", toRef: "handoff", guardKind: "llm" }),
      expect.objectContaining({ fromStep: "branch", toRef: "done", guardKind: "default" }),
    ]);
  });

  it("keeps branch-vs-nuance structural and detects token-less branch beats", () => {
    const text = `---
name: branch nuance
trigger: support
priority: 1
---

## Variables
- email: email - Email address.

## Steps

1. Ask for @email. If they mention an order, also ask for an order id. {#gather}
   if they give an email -> #done
   if they need a new conversational beat:
     Ask which address to use next.

## Ends
- done [complete]: Confirm completion for @email.
`;

    const parsed = parseRoutineDocumentFixture(text);
    const result = routineDocumentToDraft(parsed.document);

    expect(result.draft.steps).toEqual([
      expect.objectContaining({
        stableStepId: "gather",
        instruction: "Ask for {{slot.email}}. If they mention an order, also ask for an order id.",
      }),
    ]);
    expect(result.draft.transitions).toEqual([
      expect.objectContaining({
        fromStep: "gather",
        toRef: "done",
        guardKind: "llm",
        guardText: "they give an email",
      }),
    ]);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
      code: "token_less_branch_beat",
      location: "step:gather",
      message: expect.stringContaining("needs a destination"),
    }));
  });

  it("projects branchless outline steps as implicit fall-through transitions", () => {
    const document: RoutineDocument = {
      name: "implicit-fallthrough",
      activation: {
        triggerDescription: "support",
        gateRef: null,
        priority: 1,
      },
      sections: [{
        kind: "routine",
        variables: [{ stableSlotId: "email", key: "email", type: "email", required: true, description: "Email address.", ordinal: 0 }],
        steps: [
          {
            stableStepId: "ask_email",
            label: null,
            instruction: "Ask for @email.",
            kind: "chat",
            toolRef: null,
            actionType: null,
            metadata: {},
            ordinal: 0,
            branches: [],
          },
          {
            stableStepId: "confirm_email",
            label: null,
            instruction: "Confirm the address.",
            kind: "chat",
            toolRef: null,
            actionType: null,
            metadata: {},
            ordinal: 1,
            branches: [{
              fromStepId: "confirm_email",
              target: { kind: "end", stableId: "done" },
              guard: { kind: "default" },
              ordinal: 0,
            }],
          },
        ],
        ends: [{ stableStepId: "done", kind: "complete", instruction: "Done for @email.", ordinal: 0 }],
      }],
    };
    expect(routineDocumentToDraft(document).draft.transitions).toEqual([
      expect.objectContaining({ fromStep: "ask_email", toRef: "confirm_email", guardKind: "default", ordinal: 0 }),
      expect.objectContaining({ fromStep: "confirm_email", toRef: "done", guardKind: "default", ordinal: 1 }),
    ]);

    const text = `---
name: implicit-fallthrough
trigger: support
priority: 1
---

## Variables
- email: email - Email address.

## Steps

1. Ask for @email. {#ask_email}

2. Confirm the address. {#confirm_email}
   -> #done

## Ends
- done [complete]: Done for @email.
`;

    const parsed = parseRoutineDocumentFixture(text);
    const result = routineDocumentToDraft(parsed.document);

    expect(parsed.diagnostics).toEqual([]);
    expect(result.draft.transitions).toEqual([
      {
        fromStep: "ask_email",
        toRef: "confirm_email",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      },
      {
        fromStep: "confirm_email",
        toRef: "done",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 1,
      },
    ]);
    expect(mapRoutineDiagnosticToDocumentRange({
      code: "dangling_step_reference",
      location: "transition:ask_email->confirm_email",
      message: "test",
    }, result.sourceMap)).not.toBeNull();
  });

  it("maps validator-style stable-id diagnostics back to fixture text ranges", () => {
    const text = serializeRoutineDocument(routineDraftToDocument(fullDraft()));
    const parsed = parseRoutineDocumentFixture(text, {
      actionNames: ["order_lookup", "ticket_notify"],
      actionKinds: { order_lookup: "tool", ticket_notify: "action" },
    });
    const diagnostic: RoutineValidationDiagnostic = {
      code: "outcome_guard_on_non_tool_step",
      location: "transition:lookup->retry",
      message: "outcome guard on non-tool step",
    };

    const range = mapRoutineDiagnosticToDocumentRange(diagnostic, parsed.sourceMap);

    expect(range).not.toBeNull();
    expect(text.slice(range!.start.offset, range!.end.offset)).toContain("-> #retry");
  });

  it("maps routine-level validator diagnostics to the fixture frontmatter", () => {
    const text = serializeRoutineDocument(routineDraftToDocument(fullDraft()));
    const parsed = parseRoutineDocumentFixture(text, {
      actionNames: ["order_lookup", "ticket_notify"],
      actionKinds: { order_lookup: "tool", ticket_notify: "action" },
    });
    const diagnostic: RoutineValidationDiagnostic = {
      code: "missing_terminal",
      location: "routine:order-support",
      message: "missing terminal",
    };

    const range = mapRoutineDiagnosticToDocumentRange(diagnostic, parsed.sourceMap);

    expect(range).not.toBeNull();
    expect(text.slice(range!.start.offset, range!.end.offset)).toContain("name: order-support");
  });

  it("round-trips the section 8.4 worked example using explicit anchored nested beats", () => {
    const text = `---
name: retrieve-order-details
trigger: customer needs order help
priority: 10
---

## Variables
- order_date: date - Date returned by the order lookup.
- email: email - Email address used for lookup.
- order_id?: text - Order id when the customer has one.

## Steps

1. Thank them for authenticating; let them know you're pulling up their account.
   Run @OrderDetails. If it's about an order, also confirm @order_id. {#s4}
   if @order_date is older than 6 months, OR the API 404s, OR there are no results -> #s4_no_match
   -> #s5

2. Tell them you couldn't find recent orders for that email and ask if there's
   another to check. Save another email as @email. {#s4_no_match}
   -> #s4 ↺2
   -> #handoff_no_account

3. Continue with the recent order details. {#s5}
   -> #complete

## Ends
- complete [complete]: Continue the order flow.
- handoff_no_account [handoff]: Apologize and hand the visitor to a human agent.
`;
    const expected: RoutineDefinitionDraftInput = {
      name: "retrieve-order-details",
      activation: {
        triggerDescription: "customer needs order help",
        gateRef: null,
        priority: 10,
      },
      slots: [
        { stableSlotId: "order_date", key: "order_date", type: "date", required: true, description: "Date returned by the order lookup.", ordinal: 0 },
        { stableSlotId: "email", key: "email", type: "email", required: true, description: "Email address used for lookup.", ordinal: 1 },
        { stableSlotId: "order_id", key: "order_id", type: "text", required: false, description: "Order id when the customer has one.", ordinal: 2 },
      ],
      steps: [
        {
          stableStepId: "s4",
          kind: "tool",
          instruction: "Thank them for authenticating; let them know you're pulling up their account. Run @OrderDetails. If it's about an order, also confirm {{slot.order_id}}.",
          toolRef: "OrderDetails",
          actionType: null,
          ordinal: 0,
          metadata: {},
        },
        {
          stableStepId: "s4_no_match",
          kind: "chat",
          instruction: "Tell them you couldn't find recent orders for that email and ask if there's another to check. Save another email as {{slot.email}}.",
          toolRef: null,
          actionType: null,
          ordinal: 1,
          metadata: {},
        },
        {
          stableStepId: "s5",
          kind: "chat",
          instruction: "Continue with the recent order details.",
          toolRef: null,
          actionType: null,
          ordinal: 2,
          metadata: {},
        },
      ],
      transitions: [
        {
          fromStep: "s4",
          toRef: "s4_no_match",
          guardKind: "llm",
          guardText: "{{slot.order_date}} is older than 6 months, OR the API 404s, OR there are no results",
          outcomeStatus: null,
          counterLimit: null,
          ordinal: 0,
        },
        { fromStep: "s4", toRef: "s5", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 1 },
        { fromStep: "s4_no_match", toRef: "s4", guardKind: "counter", guardText: null, outcomeStatus: null, counterLimit: 2, ordinal: 2 },
        { fromStep: "s4_no_match", toRef: "handoff_no_account", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 3 },
        { fromStep: "s5", toRef: "complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 4 },
      ],
      terminals: [
        { stableStepId: "complete", kind: "complete", instruction: "Continue the order flow.", ordinal: 0 },
        { stableStepId: "handoff_no_account", kind: "handoff", instruction: "Apologize and hand the visitor to a human agent.", ordinal: 1 },
      ],
    };

    const parsed = parseRoutineDocumentFixture(text, {
      actionNames: ["OrderDetails"],
      actionKinds: { OrderDetails: "tool" },
    });
    const result = routineDocumentToDraft(parsed.document);

    expect(parsed.diagnostics).toEqual([]);
    expect(result.draft).toEqual(expected);
    expect(routineDocumentToDraft(routineDraftToDocument(expected)).draft).toEqual(expected);
  });

  it("recognizes guidelines and glossary as no-op document sections", () => {
    const text = `${serializeRoutineDocument(routineDraftToDocument(fullDraft()))}

## Guidelines
- Keep the tone calm.

## Glossary
- GLAM_BAG = Glam Bag
`;

    const parsed = parseRoutineDocumentFixture(text, {
      actionNames: ["order_lookup", "ticket_notify"],
      actionKinds: { order_lookup: "tool", ticket_notify: "action" },
    });
    const result = routineDocumentToDraft(parsed.document);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "guidelines" }),
      expect.objectContaining({ kind: "glossary" }),
    ]));
    expect(result.draft).toEqual(fullDraft());
  });

  it("rejects a name present in both variable and action reference sets", () => {
    const text = `---
name: collision
trigger: support
priority: 1
---

## Variables
- lookup: text - Ambiguous name.

## Steps

1. Run @lookup. {#start}
   -> #done

## Ends
- done [complete]: Done.
`;

    const parsed = parseRoutineDocumentFixture(text, { actionNames: ["lookup"] });

    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({
      code: "ambiguous_reference_name",
      location: "reference:lookup",
    }));
  });
});
