/**
 * Generation surface vocabulary shared across modules.
 *
 * Owned here (not in the chat module) for the same reason as `ChatTurnRoute`: a turn
 * produces visitor-facing text from more than one model call, and directives (agents
 * module), steering rendering (shared infra), and the chat composer all need the
 * vocabulary without depending on each other.
 *
 * `ANSWER` is the agent's answering voice: the answer body, and the surfaces that
 * inherit that voice because they have no scope of their own yet (the clarifying
 * question). `SUGGESTED_QUESTIONS` is the follow-up question generator, which composes
 * the visitor's next question rather than the agent's reply, and so takes rules the
 * answer body should not.
 *
 * A rule with no surface scope means `ANSWER` — the behavior every rule had before
 * this axis existed.
 */
export const GENERATION_SURFACE = {
  ANSWER: "answer",
  SUGGESTED_QUESTIONS: "suggested_questions",
} as const;

export type { GenerationSurface } from "@radioso/conversation-contract";
