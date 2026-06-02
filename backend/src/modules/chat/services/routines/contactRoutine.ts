import type { Routine } from "@radioso/conversation-contract";

/** The action type the contact routine emits; the registered handler dispatches it. */
export const CONTACT_SEND_ACTION_TYPE = "contact.send";

/** The routine id, and the intent name that activates it (see the registration). */
export const CONTACT_ROUTINE_ID = "contact.request";

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
    { id: "done", kind: "terminal", action: "Confirm their request was sent and that someone will follow up." },
  ],
  transitions: [
    { from: "ask_email", to: "ask_message", condition: "the user provided a valid email address" },
    { from: "ask_message", to: "send", condition: "the user provided the message they want to send" },
    { from: "send", to: "done", condition: "the contact request was emitted" },
  ],
};
