import { z } from "zod";

import { renderPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type { JsonSchemaResponseFormat } from "../../shared/infra/llm/providerTypes.js";
import type { AnswerCoverageEvidence } from "@radioso/conversation-contract";

import {
  type AnswerCoverageAssessment,
  type AnswerCoverageInferencePort,
} from "./contracts.js";

const schemaVersion = 1;
const classifications = {
  answered_sufficient_evidence: { coverage: "answered", reason: "sufficient_evidence" },
  partial_insufficient_evidence: { coverage: "partial", reason: "insufficient_evidence" },
  partial_conflicting_evidence: { coverage: "partial", reason: "conflicting_evidence" },
  partial_intentional_scope_boundary: { coverage: "partial", reason: "intentional_scope_boundary" },
  unanswered_insufficient_evidence: { coverage: "unanswered", reason: "insufficient_evidence" },
  unanswered_conflicting_evidence: { coverage: "unanswered", reason: "conflicting_evidence" },
  unanswered_intentional_scope_boundary: { coverage: "unanswered", reason: "intentional_scope_boundary" },
  unclear_ambiguous_request: { coverage: "unclear", reason: "ambiguous_request" },
} as const;

const classificationValues = Object.keys(classifications) as [keyof typeof classifications, ...(keyof typeof classifications)[]];

const modelOutputSchema = z.object({
  classification: z.enum(classificationValues),
  // Strict providers reject conditional null schemas. The focus is required for
  // every classification; only unresolved classifications persist it.
  requestFocus: z.string().trim().min(1).max(600),
}).strict();

const responseFormat: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "answer_coverage_assessment",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      classification: { type: "string", enum: classificationValues },
      requestFocus: { type: "string", minLength: 1, maxLength: 600 },
    },
    required: ["classification", "requestFocus"],
  },
};

interface AssessmentInput {
  contextualizedRequest: string;
  admissibleEvidence: readonly AnswerCoverageEvidence[];
  usageContext: ModelCallUsageContext;
  signal?: AbortSignal;
}

/**
 * Default semantic assessor. A provider failure never changes the already-safe
 * answer path: callers receive a non-triggering availability state instead.
 */
export class LlmAnswerCoverageProducer {
  constructor(private readonly inference: AnswerCoverageInferencePort) {}

  async assess(input: AssessmentInput): Promise<AnswerCoverageAssessment> {
    try {
      const result = await this.inference.complete({
        operation: input.usageContext,
        prompt: renderPromptTemplate("chat/answer-coverage-assessment.md", {
          contextualized_request: input.contextualizedRequest,
          admissible_evidence: input.admissibleEvidence.map((evidence) => [
            `Evidence ${evidence.id}${evidence.sourceLabel ? ` (${evidence.sourceLabel})` : ""}:`,
            evidence.content,
          ].join("\n")).join("\n\n"),
        }),
        maxOutputTokens: 384,
        responseFormat,
        signal: input.signal,
      });
      try {
        const parsed = modelOutputSchema.parse(JSON.parse(result.text ?? ""));
        return {
          availability: "assessed",
          ...classifications[parsed.classification],
          ...(classifications[parsed.classification].coverage === "answered" ? {} : { unresolvedRequest: parsed.requestFocus }),
          schemaVersion,
        };
      } catch {
        return { availability: "invalid" };
      }
    } catch {
      return { availability: "failed" };
    }
  }
}
