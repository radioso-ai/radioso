import type { TurnOutcome } from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * Wraps a prepared chat session's result into a terminal turn outcome for the given
 * skill. Capability-agnostic: each answer skill (retrieval, social, identity, …)
 * stamps its own `kind`, `skillName`, and staged-context `source`. The prepared
 * neutral spine — `session.stagedContext` and `session.turnTrace` (the pre-answer
 * dispatch trace) — is attached by the preparer (A1, issue #482); this builder
 * reads that spine and never the retrieval result, so the turn outcome stays a
 * generic conversation outcome rather than a retrieval-shaped one.
 */
export const buildPreparedTurnOutcome = (
  session: PreparedSession,
  options: { kind: string; skillName: string },
): TurnOutcome => ({
  kind: options.kind,
  skillName: options.skillName,
  outcome: { status: "completed" },
  // The preparer stages exactly one (retrieval) entry today, so stamping the
  // dispatching skill as its source is exact parity with the prior single-entry
  // code. If a future turn stages multiple contexts (e.g. retrieval + a tool
  // result), this blanket re-source is wrong — only entries the dispatching skill
  // owns should carry its name; revisit then rather than re-sourcing all of them.
  stagedContext: session.stagedContext.map((staged) => ({ ...staged, source: options.skillName })),
  steering: session.directiveSteering?.rules ?? [],
  trace: session.turnTrace,
});
