import { describe, expect, it, vi } from "vitest";

import { ChatGatewayLlmJudge } from "../../src/modules/eval/services/evalJudge.js";
import type { EvalAssertion } from "../../src/modules/eval/domain/types.js";

const judgeAssertion: Extract<EvalAssertion, { type: "llm_judge" }> = {
  type: "llm_judge",
  expectedAnswer: "Refund window is 30 days.",
};

const buildGateway = (answer: string | Error) => ({
  answer: vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  }),
  streamAnswer: vi.fn(),
});

const baseInput = {
  workspaceId: "ws-1",
  runId: "run-test",
  assertionIndex: 0,
} as const;

describe("ChatGatewayLlmJudge.judge", () => {
  it("returns pass when the judge replies with JSON verdict=pass", async () => {
    const gateway = buildGateway('{"verdict":"pass","reason":"Equivalent in meaning."}');
    const judge = new ChatGatewayLlmJudge(gateway);

    const verdict = await judge.judge({
      ...baseInput,
      assertion: judgeAssertion,
      observedAnswer: "Our refund window is thirty days.",
      question: "When can I get a refund?",
    });

    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("Equivalent");
  });

  it("returns fail when the judge replies with JSON verdict=fail", async () => {
    const gateway = buildGateway('{"verdict":"fail","reason":"Missing the 30-day window."}');
    const judge = new ChatGatewayLlmJudge(gateway);

    const verdict = await judge.judge({
      ...baseInput,
      assertion: judgeAssertion,
      observedAnswer: "I don't know.",
      question: "When can I get a refund?",
    });

    expect(verdict.status).toBe("fail");
  });

  it("strips ```json fences before parsing", async () => {
    const gateway = buildGateway('```json\n{"verdict":"pass","reason":"ok"}\n```');
    const judge = new ChatGatewayLlmJudge(gateway);

    const verdict = await judge.judge({
      ...baseInput,
      assertion: judgeAssertion,
      observedAnswer: "Refund within 30 days.",
      question: "Refund policy?",
    });
    expect(verdict.status).toBe("pass");
  });

  it("returns error when the judge response cannot be parsed as JSON", async () => {
    const gateway = buildGateway("yes that looks correct");
    const judge = new ChatGatewayLlmJudge(gateway);

    const verdict = await judge.judge({
      ...baseInput,
      assertion: judgeAssertion,
      observedAnswer: "any",
      question: "any",
    });
    expect(verdict.status).toBe("error");
  });

  it("returns error when the verdict field is not pass/fail", async () => {
    const gateway = buildGateway('{"verdict":"maybe","reason":"uncertain"}');
    const judge = new ChatGatewayLlmJudge(gateway);

    const verdict = await judge.judge({
      ...baseInput,
      assertion: judgeAssertion,
      observedAnswer: "any",
      question: "any",
    });
    expect(verdict.status).toBe("error");
    expect(verdict.reason).toMatch(/verdict/);
  });

  it("returns error when the gateway call throws", async () => {
    const gateway = buildGateway(new Error("provider 500"));
    const judge = new ChatGatewayLlmJudge(gateway);

    const verdict = await judge.judge({
      ...baseInput,
      assertion: judgeAssertion,
      observedAnswer: "any",
      question: "any",
    });
    expect(verdict.status).toBe("error");
    expect(verdict.reason).toContain("provider 500");
  });

  it("includes additional criteria in the user prompt", async () => {
    const gateway = buildGateway('{"verdict":"pass","reason":"ok"}');
    const judge = new ChatGatewayLlmJudge(gateway);

    await judge.judge({
      ...baseInput,
      assertion: { ...judgeAssertion, criteria: "Must mention 30-day window explicitly." },
      observedAnswer: "Refund window is 30 days.",
      question: "Refund policy?",
    });

    const firstCall = gateway.answer.mock.calls[0] as unknown as [{ prompt: string }] | undefined;
    expect(firstCall?.[0].prompt).toContain("Must mention 30-day window explicitly.");
  });
});
