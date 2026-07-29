import type { MessageSource } from "@radioso/conversation-contract";

/**
 * Message sources written by a human teammate rather than by the AI agent: a direct
 * operator reply, and an operator reply sent on behalf of the AI. Both are stored with
 * `role = 'assistant'`, so role alone cannot tell an AI turn from a human one.
 *
 * Operator triage surfaces read this to keep human replies out of AI-quality
 * populations — a human's own reply has no skill outcome and no model latency, so
 * counting it inflates turn volume and depresses every quality rate.
 */
export const HUMAN_AUTHORED_MESSAGE_SOURCES = [
  "human_agent",
  "human_agent_on_behalf_of_ai_agent",
] as const satisfies readonly MessageSource[];

/**
 * Whether a message was authored by a human teammate. Null-safe: rows written before
 * the `source` column existed carry NULL and are treated as AI-authored, matching how
 * `deriveMessageSourceFromRole` resolves them on read.
 */
export const isHumanAuthoredMessageSource = (source: string | null | undefined): boolean =>
  source != null && (HUMAN_AUTHORED_MESSAGE_SOURCES as readonly string[]).includes(source);
