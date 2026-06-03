import type { Routine } from "@radioso/conversation-contract";

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
 * A chat-only contact routine: it gathers an email and a message through chat steps,
 * then emits a `contact.send` action (fire-and-forget) and confirms. There is no skill
 * step — the side effect is dispatched out of band by the action handler, so the
 * conversation never blocks on sending. The step `action` strings steer the reply
 * wording (the LLM renders them, multilingually); the routine hard-codes no copy.
 */
export const contactRoutine: Routine = {
  id: CONTACT_ROUTINE_ID,
  rootStepId: "ask_email",
  steps: [
    { id: "ask_email", kind: "chat", action: "Ask the user for the email address where they can be reached." },
    { id: "ask_message", kind: "chat", action: "Ask the user for the message they would like to send." },
    { id: "send", kind: "action", actionType: CONTACT_SEND_ACTION_TYPE },
    { id: "done", kind: "terminal", action: "Confirm their request was sent and that someone will follow up. Ask what you can help with next." },
    { id: "cancelled", kind: "terminal", action: "Acknowledge that the contact request was cancelled and that they do not need to provide anything else." },
  ],
  transitions: [
    { from: "ask_email", to: "cancelled", condition: "the user declined, cancelled, refused, or said they no longer want to continue the contact request" },
    { from: "ask_email", to: "ask_message", condition: "the user provided a valid email address and did not decline or cancel the contact request" },
    { from: "ask_message", to: "cancelled", condition: "the user declined, cancelled, refused, or said they no longer want to continue the contact request" },
    { from: "ask_message", to: "send", condition: "the user provided the message they want to send and did not decline or cancel the contact request" },
    { from: "send", to: "done", condition: "the contact request was emitted" },
  ],
};
