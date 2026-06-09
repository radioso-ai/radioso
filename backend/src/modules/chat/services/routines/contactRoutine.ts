import type { RoutineDefinition } from "../../../routines/public.js";

/** The action type the contact routine emits; the registered handler dispatches it. */
export const CONTACT_SEND_ACTION_TYPE = "contact.send";

/** The routine id. */
export const CONTACT_ROUTINE_ID = "contact.request";

/**
 * The explicit intent that activates the routine. These match the public chat UI's
 * "contact a human" affordance (`frontend/components/chat/public-chat-shell.tsx`), so
 * the existing button starts the routine — the routine consumes the existing signal
 * rather than inventing a new one. The intake advertiser surfaces this same action so
 * the button renders; the activator starts the routine when a turn carries it.
 */
export const CONTACT_INTENT_SKILL_NAME = "human_contact.request";
export const CONTACT_INTENT_NAME = "explicit_contact_request";

/**
 * A chat-only contact routine authored as RoutineDefinition data: it gathers an
 * email and a message through chat steps, then emits a `contact.send` action
 * (fire-and-forget) and confirms. There is no skill step — the side effect is
 * dispatched out of band by the action handler, so the conversation never blocks on
 * sending. The step instructions steer the reply wording (the LLM renders them,
 * multilingually); the routine hard-codes no copy.
 */
export const contactRoutineDefinition: RoutineDefinition = {
  id: "builtin_contact_request_v1",
  agentId: "builtin",
  name: CONTACT_ROUTINE_ID,
  version: 1,
  status: "published",
  activation: {
    triggerDescription: "The user asks a human to follow up with them.",
    gateRef: CONTACT_INTENT_SKILL_NAME,
    priority: 100,
  },
  slots: [],
  steps: [
    {
      stableStepId: "ask_email",
      kind: "chat",
      instruction: "Ask the user for the email address where they can be reached.",
      toolRef: null,
      ordinal: 0,
      metadata: {},
    },
    {
      stableStepId: "ask_message",
      kind: "chat",
      instruction: "Ask the user for the message they would like to send.",
      toolRef: null,
      ordinal: 1,
      metadata: {},
    },
    {
      stableStepId: "send",
      kind: "action",
      instruction: "Emit the contact request.",
      toolRef: null,
      actionType: CONTACT_SEND_ACTION_TYPE,
      ordinal: 2,
      metadata: {},
    },
  ],
  transitions: [
    {
      fromStep: "ask_email",
      toRef: "cancelled",
      guardKind: "llm",
      guardText: "the user declined, cancelled, refused, or said they no longer want to continue the contact request",
      ordinal: 0,
    },
    {
      fromStep: "ask_email",
      toRef: "ask_message",
      guardKind: "llm",
      guardText: "the user provided a valid email address and did not decline or cancel the contact request",
      ordinal: 1,
    },
    {
      fromStep: "ask_message",
      toRef: "cancelled",
      guardKind: "llm",
      guardText: "the user declined, cancelled, refused, or said they no longer want to continue the contact request",
      ordinal: 2,
    },
    {
      fromStep: "ask_message",
      toRef: "send",
      guardKind: "llm",
      guardText: "the user provided the message they want to send and did not decline or cancel the contact request",
      ordinal: 3,
    },
    {
      fromStep: "send",
      toRef: "done",
      guardKind: "llm",
      guardText: "the contact request was emitted",
      ordinal: 4,
    },
  ],
  terminals: [
    {
      stableStepId: "done",
      kind: "complete",
      instruction: "Confirm their request was sent and that someone will follow up. Ask what you can help with next.",
      ordinal: 0,
    },
    {
      stableStepId: "cancelled",
      kind: "complete",
      instruction: "Acknowledge that the contact request was cancelled and that they do not need to provide anything else.",
      ordinal: 1,
    },
  ],
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: new Date("2026-06-09T00:00:00.000Z"),
};
