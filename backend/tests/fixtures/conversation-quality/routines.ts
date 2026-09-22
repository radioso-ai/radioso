import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

/**
 * Two seed routines the suite exercises. They are authored `RoutineDefinition`s — the
 * same shape an operator would publish — so a case can assert both that a routine claims
 * the turn and how far it advances. Ids are stable constants referenced by cases.
 */
export const CONTACT_SUPPORT_ROUTINE_ID = "routine:cq-agent:contact-support:v1";
export const BOOK_DEMO_ROUTINE_ID = "routine:cq-agent:book-demo:v1";
export const START_RETURN_ROUTINE_ID = "routine:cq-agent:start-return:v1";
/** The tool name `startReturnRoutine` is exposed under; the same name in chat and on the agent-facing doors. */
export const START_RETURN_TOOL_NAME = "start_return";
/** The skill the return routine dispatches once it holds an order id and a reason. */
export const CREATE_RETURN_TICKET_SKILL = "create_return_ticket";

export const CQ_AGENT_ID = "cq-agent";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

const defaultTransition = (fromStep: string, toRef: string, ordinal: number) => ({
  fromStep,
  toRef,
  guardKind: "default" as const,
  guardText: null,
  outcomeStatus: null,
  counterLimit: null,
  fieldRef: null,
  fieldOp: null,
  fieldValue: null,
  fieldValues: null,
  fieldUnit: null,
  ordinal,
});

export const contactSupportRoutine: RoutineDefinition = {
  id: CONTACT_SUPPORT_ROUTINE_ID,
  agentId: CQ_AGENT_ID,
  lineageId: "lineage:contact-support",
  version: 1,
  enabled: true,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  name: "Contact support",
  activation: {
    triggerDescription: "the user explicitly asks to reach a human or open a support ticket so somebody can follow up",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [
    { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: "The email address we can reach them at.", ordinal: 0 },
    { stableSlotId: "slot_issue", key: "issue", type: "text", required: true, description: "A short description of the problem.", ordinal: 1 },
  ],
  steps: [
    { stableStepId: "ask_email", kind: "chat", instruction: "Ask what email address we can reach them at: {{slot.email}}", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_issue", kind: "chat", instruction: "Ask them to describe the problem they are having: {{slot.issue}}", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    defaultTransition("ask_email", "ask_issue", 0),
    defaultTransition("ask_issue", "done", 1),
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm that a support agent will follow up by email.", ordinal: 0 },
  ],
};

export const bookDemoRoutine: RoutineDefinition = {
  id: BOOK_DEMO_ROUTINE_ID,
  agentId: CQ_AGENT_ID,
  lineageId: "lineage:book-demo",
  version: 1,
  enabled: true,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  name: "Book a demo",
  activation: {
    triggerDescription: "the user wants to book, schedule, or arrange a product demo or sales call",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "The person's name.", ordinal: 0 },
    { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: "A work email to send the invite to.", ordinal: 1 },
    { stableSlotId: "slot_date", key: "preferredDate", type: "date", required: true, description: "Their preferred date for the demo.", ordinal: 2 },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for the person's name: {{slot.name}}", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_email", kind: "chat", instruction: "Ask for a work email to send the calendar invite to: {{slot.email}}", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
    { stableStepId: "ask_date", kind: "chat", instruction: "Ask what date works best for the demo: {{slot.preferredDate}}", toolRef: null, actionType: null, ordinal: 2, metadata: {} },
  ],
  transitions: [
    defaultTransition("ask_name", "ask_email", 0),
    defaultTransition("ask_email", "ask_date", 1),
    defaultTransition("ask_date", "done", 2),
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm the demo request and that the team will send an invite.", ordinal: 0 },
  ],
};

/**
 * The exposed routine SC-002 drives two ways — as a human transcript and as one tool
 * call — to show both reach the same step and the same skill effect. It carries a
 * tool step so "the skill ran" is observable in the trace.
 */
export const startReturnRoutine: RoutineDefinition = {
  id: START_RETURN_ROUTINE_ID,
  agentId: CQ_AGENT_ID,
  lineageId: "lineage:start-return",
  version: 1,
  enabled: true,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  name: "Start a return",
  activation: {
    // Narrow on purpose: refund-window and billing questions in this suite must keep routing to
    // retrieval, so this fires only when the user is actually sending a physical order back.
    triggerDescription: "the user has a physical order in hand and says they want to send it back for a return — not a question about refund timelines, billing, charges, or policy",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  exposure: {
    enabled: true,
    toolName: START_RETURN_TOOL_NAME,
    description: "Start a return for an order the customer received. Needs the order id; a reason helps the team route it.",
  },
  slots: [
    { stableSlotId: "slot_order", key: "orderId", type: "text", required: true, description: "The order number on the confirmation email.", ordinal: 0 },
    { stableSlotId: "slot_reason", key: "reason", type: "text", required: false, description: "Why the order is coming back.", ordinal: 1 },
  ],
  steps: [
    { stableStepId: "ask_order", kind: "chat", instruction: "Ask for the order number: {{slot.orderId}}", toolRef: null, actionType: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_reason", kind: "chat", instruction: "Ask why the order is coming back: {{slot.reason}}", toolRef: null, actionType: null, ordinal: 1, metadata: {} },
    { stableStepId: "create_return", kind: "tool", instruction: "Open the return ticket for {{slot.orderId}}.", toolRef: CREATE_RETURN_TICKET_SKILL, actionType: null, ordinal: 2, metadata: {} },
  ],
  transitions: [
    defaultTransition("ask_order", "ask_reason", 0),
    defaultTransition("ask_reason", "create_return", 1),
    defaultTransition("create_return", "done", 2),
  ],
  terminals: [
    { stableStepId: "done", kind: "complete", instruction: "Confirm the return ticket is open and what happens next.", ordinal: 0 },
  ],
};

export const conversationQualityRoutines: RoutineDefinition[] = [contactSupportRoutine, bookDemoRoutine, startReturnRoutine];
