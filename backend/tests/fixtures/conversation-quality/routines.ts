import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

/**
 * Two seed routines the suite exercises. They are authored `RoutineDefinition`s — the
 * same shape an operator would publish — so a case can assert both that a routine claims
 * the turn and how far it advances. Ids are stable constants referenced by cases.
 */
export const CONTACT_SUPPORT_ROUTINE_ID = "routine:cq-agent:contact-support:v1";
export const BOOK_DEMO_ROUTINE_ID = "routine:cq-agent:book-demo:v1";

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
  status: "published",
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
  status: "published",
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

export const conversationQualityRoutines: RoutineDefinition[] = [contactSupportRoutine, bookDemoRoutine];
