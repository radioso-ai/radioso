import type { ChatGateway } from "../../chat/contracts/index.js";
import type { AssertionVerdict, EvalAssertion } from "../domain/types.js";

/**
 * Port for the LLM-as-judge primitive. Given a judge assertion + the
 * observed answer from a full_assistant run, returns a structured verdict.
 *
 * Lives behind a port so the eval module doesn't depend on a specific
 * chat gateway and so judges can be swapped (different model, deterministic
 * fixtures in tests, future scoring rubrics).
 */
export interface EvalLlmJudgePort {
  judge(input: {
    workspaceId: string;
    accountId?: string | null;
    runId: string;
    assertionIndex: number;
    assertion: Extract<EvalAssertion, { type: "llm_judge" }>;
    observedAnswer: string;
    question: string;
  }): Promise<AssertionVerdict>;
}

const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge. Your job is to decide whether an assistant's answer is acceptable given a reference answer.

You reply with a single JSON object on one line, with no commentary outside the JSON.

The JSON schema is:
{"verdict": "pass" | "fail", "reason": "<one short sentence explaining why>"}

Rules:
- The observed answer does not need to be identical to the reference. Semantic equivalence and factual correctness are what matter.
- If the observed answer is factually wrong, missing critical information from the reference, or hallucinates content not implied by the reference, return "fail".
- If the observed answer says it doesn't know but the reference answers the question, return "fail".
- If additional grading criteria are provided, apply them in addition to the rules above.
- Keep the reason to under 200 characters.`;

const buildUserPrompt = (
  question: string,
  expectedAnswer: string,
  observedAnswer: string,
  criteria?: string,
): string => {
  const sections = [
    "QUESTION:",
    question,
    "",
    "REFERENCE ANSWER (what is considered correct):",
    expectedAnswer,
    "",
    "OBSERVED ASSISTANT ANSWER (to be graded):",
    observedAnswer,
  ];
  if (criteria && criteria.trim()) {
    sections.push("", "ADDITIONAL GRADING CRITERIA:", criteria.trim());
  }
  sections.push("", 'Return the JSON verdict now.');
  return sections.join("\n");
};

interface JudgeVerdict {
  verdict: "pass" | "fail";
  reason: string;
}

const parseJudgeResponse = (raw: string): JudgeVerdict | { error: string } => {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Judge returned an empty response." };

  // Strip code fences if the LLM wrapped the JSON despite instructions.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Best-effort: find the first { ... } JSON object in the response.
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { error: "Judge response did not contain JSON." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    return { error: `Judge response was not valid JSON: ${err instanceof Error ? err.message : "parse error"}` };
  }
  if (!parsed || typeof parsed !== "object") return { error: "Judge JSON was not an object." };
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "pass" && verdict !== "fail") {
    return { error: `Judge verdict was ${JSON.stringify(verdict)} — expected "pass" or "fail".` };
  }
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { verdict, reason };
};

export class ChatGatewayLlmJudge implements EvalLlmJudgePort {
  constructor(private readonly chatGateway: ChatGateway) {}

  async judge(input: {
    workspaceId: string;
    accountId?: string | null;
    runId: string;
    assertionIndex: number;
    assertion: Extract<EvalAssertion, { type: "llm_judge" }>;
    observedAnswer: string;
    question: string;
  }): Promise<AssertionVerdict> {
    const prompt = buildUserPrompt(
      input.question,
      input.assertion.expectedAnswer,
      input.observedAnswer,
      input.assertion.criteria,
    );

    let raw = "";
    let callError: unknown = null;
    try {
      raw = await this.chatGateway.answer({
        query: input.question,
        history: [],
        prompt,
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        workspaceContext: { workspaceId: input.workspaceId },
        usageContext: {
          accountId: input.accountId ?? null,
          workspaceId: input.workspaceId,
          requestId: input.runId,
          surface: "eval",
          operation: "llm_judge",
          attemptKey: `assertion-${input.assertionIndex}`,
        },
      });
    } catch (err) {
      callError = err;
    }

    if (callError) {
      return {
        assertion: input.assertion,
        status: "error",
        reason: `Judge LLM call failed: ${callError instanceof Error ? callError.message : "unknown error"}`,
      };
    }

    const parsed = parseJudgeResponse(raw);
    if ("error" in parsed) {
      return { assertion: input.assertion, status: "error", reason: parsed.error };
    }
    return {
      assertion: input.assertion,
      status: parsed.verdict,
      reason: parsed.reason || (parsed.verdict === "pass" ? "Judge accepted the answer." : "Judge rejected the answer."),
    };
  }
}
