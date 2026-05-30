import type { TurnOutcome } from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";
import { toConversationTrace, toRetrievalStagedContext } from "./conversationContractMappers.js";

/**
 * Wraps a prepared chat session's result into a terminal turn outcome for the given
 * skill. Capability-agnostic: each answer skill (retrieval, social, identity, …)
 * stamps its own `kind` and `skillName`. The prepared result rides on
 * `stagedContext`/`trace`; the skill's renderer composes the actual reply.
 */
export const buildPreparedTurnOutcome = (
  session: PreparedSession,
  options: { kind: string; skillName: string },
): TurnOutcome => ({
  kind: options.kind,
  skillName: options.skillName,
  outcome: { status: "completed" },
  stagedContext: [toRetrievalStagedContext(session.retrieval)],
  steering: session.directiveSteering?.rules ?? [],
  trace: toConversationTrace(session.retrieval.trace),
});
