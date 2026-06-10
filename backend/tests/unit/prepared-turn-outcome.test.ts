import { describe, expect, it } from "vitest";

import type { ConversationTrace, StagedContext } from "@radioso/conversation-contract";

import { buildPreparedTurnOutcome } from "../../src/modules/chat/services/preparedTurnOutcome.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

// A1 (issue #482): `buildPreparedTurnOutcome` consumes the neutral spine the
// preparer attaches (`session.stagedContext` / `session.turnTrace`) and no longer
// derives staged context or trace from `session.retrieval`. These sentinels prove
// the decoupling: `session.retrieval.trace` is deliberately different from
// `session.turnTrace`, and the outcome must carry the latter.
const turnTrace: ConversationTrace = {
  traceId: "neutral-turn-trace",
  startedAt: new Date(0).toISOString(),
  stages: [],
};

const stagedContext: StagedContext[] = [
  { kind: "retrieval", data: { marker: "prepared-staged-data" }, metadata: { contextCount: 2 } },
];

const session = (): PreparedSession =>
  ({
    directiveSteering: { rules: [{ action: "be concise", source: "directive", lifespan: "response" }], matches: [], omissions: [] },
    stagedContext,
    turnTrace,
    // A distinct trace on the retrieval result; the outcome must ignore it.
    retrieval: { trace: { traceId: "retrieval-trace-should-be-ignored", startedAt: "x", stages: [] } },
  } as unknown as PreparedSession);

describe("buildPreparedTurnOutcome (A1 neutral spine)", () => {
  it("carries the session's neutral turn trace, not the retrieval result's trace", () => {
    const outcome = buildPreparedTurnOutcome(session(), { kind: "retrieval", skillName: "retrieval.answer" });
    expect(outcome.trace).toBe(turnTrace);
    expect(outcome.trace.traceId).toBe("neutral-turn-trace");
  });

  it("stamps the dispatching skill name onto the staged context entries", () => {
    const outcome = buildPreparedTurnOutcome(session(), { kind: "direct", skillName: "direct.answer" });
    expect(outcome.stagedContext).toHaveLength(1);
    expect(outcome.stagedContext[0]).toMatchObject({
      kind: "retrieval",
      source: "direct.answer",
      data: { marker: "prepared-staged-data" },
      metadata: { contextCount: 2 },
    });
  });

  it("passes through directive steering rules and marks the outcome completed", () => {
    const outcome = buildPreparedTurnOutcome(session(), { kind: "retrieval", skillName: "retrieval.answer" });
    expect(outcome.outcome).toEqual({ status: "completed" });
    expect(outcome.steering).toEqual([{ action: "be concise", source: "directive", lifespan: "response" }]);
  });
});
