import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * The same bounded recent-history framing the coverage head recorder uses
 * (`answerCoverageHeadRecorder.ts`), shared so the envelope head's deterministic
 * zero-evidence assessment (#1260) judges the same "what is this turn actually
 * asking" framing rather than restating its own.
 */
export const buildContextualizedRequest = (session: Pick<PreparedSession, "history" | "effectiveQuery">, request: string): string => {
  const history = session.history.slice(-6).map((message) => `${message.role}: ${message.content}`).join("\n");
  return history ? `${history}\nuser: ${session.effectiveQuery || request}` : session.effectiveQuery || request;
};
