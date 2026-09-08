import { describe, expect, it, vi } from "vitest";

import {
  LlmAnswerCoverageProducer,
  type AnswerCoverageInferencePort,
} from "../../../src/modules/answerCoverage/public.js";

const input = {
  contextualizedRequest: "Can I attend for one day?",
  admissibleEvidence: [{ id: "chunk-1", sourceLabel: "Course guide", content: "The course runs every week." }],
  usageContext: {
    workspaceId: "workspace-1",
    surface: "assistant" as const,
    operation: "answer_coverage_assessment",
    attemptKey: "answer-coverage:user-1",
  },
};

describe("LlmAnswerCoverageProducer", () => {
  it.each([
    {
      name: "contextual Spanish correction keeps the one-day attendance request unresolved",
      request: "usuario: Quiero conocer a la maestra visitante.\nusuario: No, me refiero a Lucía. ¿Puedo asistir solo un día?",
      evidence: "El retiro dura siete días y presenta a Lucía como maestra visitante.",
      output: { classification: "unanswered_insufficient_evidence", requestFocus: "Permiso para asistir un solo día" },
      expected: { coverage: "unanswered", reason: "insufficient_evidence", unresolvedRequest: "Permiso para asistir un solo día" },
    },
    {
      name: "explicit negative attendance rule is an answered request",
      request: "Can I attend only one day?",
      evidence: "Single-day attendance is not permitted.",
      output: { classification: "answered_sufficient_evidence", requestFocus: "One-day attendance" },
      expected: { coverage: "answered", reason: "sufficient_evidence" },
    },
    {
      name: "date answered while attendance rule is absent is partial",
      request: "What date is the workshop, and may I attend for one day?",
      evidence: "The workshop starts on 12 June.",
      output: { classification: "partial_insufficient_evidence", requestFocus: "Whether one-day attendance is allowed" },
      expected: { coverage: "partial", reason: "insufficient_evidence", unresolvedRequest: "Whether one-day attendance is allowed" },
    },
    {
      name: "ambiguous referent requires clarification",
      request: "Can I join it?",
      evidence: "The workspace describes several courses.",
      output: { classification: "unclear_ambiguous_request", requestFocus: "Which course the visitor means" },
      expected: { coverage: "unclear", reason: "ambiguous_request", unresolvedRequest: "Which course the visitor means" },
    },
    {
      name: "conflicting attendance rules remain unresolved",
      request: "Can I attend only one day?",
      evidence: "Guide A permits one-day attendance. Guide B prohibits it.",
      output: { classification: "unanswered_conflicting_evidence", requestFocus: "Whether one-day attendance is permitted" },
      expected: { coverage: "unanswered", reason: "conflicting_evidence", unresolvedRequest: "Whether one-day attendance is permitted" },
    },
  ])("deterministically carries the $name coverage evaluation case through the bounded model contract", async ({ request, evidence, output, expected }) => {
    const complete = vi.fn(async () => ({ text: JSON.stringify(output) }));
    const producer = new LlmAnswerCoverageProducer({ complete } satisfies AnswerCoverageInferencePort);

    await expect(producer.assess({
      ...input,
      contextualizedRequest: request,
      admissibleEvidence: [{ id: "case-evidence", content: evidence }],
    })).resolves.toMatchObject({ availability: "assessed", ...expected });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining(request),
    }));
  });

  it("uses strict structured output and returns a typed assessment", async () => {
    const complete = vi.fn(async () => ({ text: JSON.stringify({
      classification: "unanswered_insufficient_evidence",
      requestFocus: "Whether one-day attendance is allowed",
    }) }));
    const producer = new LlmAnswerCoverageProducer({ complete } satisfies AnswerCoverageInferencePort);

    await expect(producer.assess(input)).resolves.toEqual({
      availability: "assessed",
      coverage: "unanswered",
      reason: "insufficient_evidence",
      unresolvedRequest: "Whether one-day attendance is allowed",
      schemaVersion: 1,
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 384,
      responseFormat: expect.objectContaining({
        type: "json_schema",
        strict: true,
        schema: expect.objectContaining({
          properties: expect.objectContaining({
            classification: {
              type: "string",
              enum: expect.arrayContaining([
                "answered_sufficient_evidence",
                "partial_insufficient_evidence",
                "unanswered_insufficient_evidence",
                "unclear_ambiguous_request",
              ]),
            },
            requestFocus: { type: "string", minLength: 1, maxLength: 600 },
          }),
        }),
      }),
    }));
  });

  it("instructs the assessor that related background cannot make one atomic decision partial", async () => {
    const complete = vi.fn(async () => ({ text: JSON.stringify({
      classification: "unanswered_insufficient_evidence",
      requestFocus: "Whether one-day attendance is permitted",
    }) }));
    const producer = new LlmAnswerCoverageProducer({ complete } satisfies AnswerCoverageInferencePort);

    await producer.assess(input);

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("atomic request partial"),
    }));
  });

  it("turns malformed output into invalid instead of a semantic trigger", async () => {
    const producer = new LlmAnswerCoverageProducer({
      complete: async () => ({ text: "not json" }),
    });

    await expect(producer.assess(input)).resolves.toEqual({ availability: "invalid" });
  });

  it("keeps a provider failure on the normal safe-answer path as failed", async () => {
    const producer = new LlmAnswerCoverageProducer({
      complete: async () => { throw new Error("provider unavailable"); },
    });

    await expect(producer.assess(input)).resolves.toEqual({ availability: "failed" });
  });
});
