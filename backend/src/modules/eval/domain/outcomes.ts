import type {
  AnswerMatchMode,
  AssertionVerdict,
  EvalAssertion,
  EvalRunObservedOutput,
  EvalRunStatus,
} from "./types.js";

const summarizeMatch = (mode: AnswerMatchMode, pattern: string): string =>
  mode === "regex" ? `regex /${pattern}/` : `substring "${pattern}"`;

const answerMatches = (
  answer: string,
  pattern: string,
  mode: AnswerMatchMode,
  caseSensitive: boolean,
): { matched: boolean; error?: string } => {
  if (mode === "regex") {
    try {
      const flags = caseSensitive ? "" : "i";
      const re = new RegExp(pattern, flags);
      return { matched: re.test(answer) };
    } catch (err) {
      return { matched: false, error: err instanceof Error ? err.message : "Invalid regex" };
    }
  }
  const haystack = caseSensitive ? answer : answer.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  return { matched: haystack.includes(needle) };
};

export const isLlmJudgeAssertion = (
  a: EvalAssertion,
): a is Extract<EvalAssertion, { type: "llm_judge" }> => a.type === "llm_judge";

export const evaluateAssertion = (
  assertion: EvalAssertion,
  output: EvalRunObservedOutput,
): AssertionVerdict => {
  if (output.error) {
    return {
      assertion,
      status: "error",
      reason: output.error.message,
    };
  }

  switch (assertion.type) {
    case "retrieval_includes_document": {
      const hit = output.retrievedChunks.find(
        (chunk) => chunk.documentId === assertion.documentId,
      );
      if (hit) {
        return {
          assertion,
          status: "pass",
          reason: `Retrieval included a chunk from document ${assertion.documentId} at rank ${hit.rank}.`,
        };
      }
      return {
        assertion,
        status: "fail",
        reason: `Retrieval did not include any chunk from document ${assertion.documentId}. Got ${output.retrievedChunks.length} chunks from ${new Set(output.retrievedChunks.map((c) => c.documentId)).size} other documents.`,
      };
    }
    case "retrieval_excludes_document": {
      const hit = output.retrievedChunks.find(
        (chunk) => chunk.documentId === assertion.documentId,
      );
      if (!hit) {
        return {
          assertion,
          status: "pass",
          reason: `Retrieval did not include any chunk from document ${assertion.documentId}.`,
        };
      }
      return {
        assertion,
        status: "fail",
        reason: `Retrieval still included a chunk from document ${assertion.documentId} at rank ${hit.rank}.`,
      };
    }
    case "retrieval_top_k_includes_document": {
      if (!Number.isInteger(assertion.k) || assertion.k <= 0) {
        return {
          assertion,
          status: "error",
          reason: `Invalid k=${assertion.k} — must be a positive integer.`,
        };
      }
      const topK = output.retrievedChunks.slice(0, assertion.k);
      const positionInTopK = topK.findIndex((chunk) => chunk.documentId === assertion.documentId);
      if (positionInTopK !== -1) {
        return {
          assertion,
          status: "pass",
          reason: `Document ${assertion.documentId} appeared in the top ${assertion.k} at rank ${positionInTopK + 1}.`,
        };
      }
      const anywhere = output.retrievedChunks.findIndex(
        (chunk) => chunk.documentId === assertion.documentId,
      );
      const tail = anywhere === -1
        ? "It was not retrieved at all."
        : `It appeared at rank ${anywhere + 1} but was outside the top ${assertion.k}.`;
      return {
        assertion,
        status: "fail",
        reason: `Document ${assertion.documentId} did not appear in the top ${assertion.k} retrieved chunks. ${tail}`,
      };
    }
    case "answer_contains":
    case "answer_does_not_contain": {
      const expectsMatch = assertion.type === "answer_contains";
      if (typeof output.answer !== "string") {
        return {
          assertion,
          status: "error",
          reason: `${assertion.type} requires an answer in the run output. Run the case in full_assistant mode.`,
        };
      }
      if (!assertion.pattern) {
        return { assertion, status: "error", reason: "Pattern cannot be empty." };
      }
      const caseSensitive = assertion.caseSensitive ?? false;
      const result = answerMatches(output.answer, assertion.pattern, assertion.matchMode, caseSensitive);
      if (result.error) {
        return { assertion, status: "error", reason: result.error };
      }
      const summary = summarizeMatch(assertion.matchMode, assertion.pattern);
      if (expectsMatch) {
        return result.matched
          ? { assertion, status: "pass", reason: `Answer matched ${summary}.` }
          : { assertion, status: "fail", reason: `Answer did not match ${summary}.` };
      }
      return result.matched
        ? { assertion, status: "fail", reason: `Answer unexpectedly matched ${summary}.` }
        : { assertion, status: "pass", reason: `Answer did not contain ${summary}.` };
    }
    case "llm_judge": {
      // Judge is async and lives behind a port. The run service handles
      // these separately; evaluateAssertion is only invoked for non-judge
      // assertions, so reaching here means caller misuse.
      return {
        assertion,
        status: "error",
        reason: "llm_judge must be evaluated via the judge port, not the sync evaluator.",
      };
    }
  }
};

export interface AggregatedRunVerdict {
  status: EvalRunStatus;
  reason: string | null;
  verdicts: AssertionVerdict[];
}

export const combineVerdicts = (verdicts: AssertionVerdict[]): AggregatedRunVerdict => {
  if (verdicts.length === 0) {
    return { status: "recorded", reason: null, verdicts: [] };
  }
  const errored = verdicts.find((v) => v.status === "error");
  if (errored) {
    return { status: "error", reason: errored.reason, verdicts };
  }
  const failed = verdicts.find((v) => v.status === "fail");
  if (failed) {
    return { status: "fail", reason: failed.reason, verdicts };
  }
  return {
    status: "pass",
    reason: verdicts.length === 1
      ? verdicts[0]!.reason
      : `All ${verdicts.length} assertions passed.`,
    verdicts,
  };
};

export const aggregateAssertions = (
  assertions: EvalAssertion[],
  output: EvalRunObservedOutput,
): AggregatedRunVerdict => {
  if (output.error) {
    return {
      status: "error",
      reason: output.error.message,
      verdicts: assertions.map((assertion) => ({
        assertion,
        status: "error" as const,
        reason: output.error!.message,
      })),
    };
  }

  if (assertions.length === 0) {
    return { status: "recorded", reason: null, verdicts: [] };
  }

  return combineVerdicts(assertions.map((a) => evaluateAssertion(a, output)));
};
