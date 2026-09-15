import { z } from "zod";

import { renderPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type { JsonSchemaResponseFormat } from "../../shared/infra/llm/providerTypes.js";
import type { AnswerCoverageEvidence } from "@radioso/conversation-contract";

import {
  ANSWER_COVERAGE_SCHEMA_VERSION,
  classifications,
  classificationValues,
  REQUEST_FOCUS_MAX_LENGTH,
  type AnswerCoverageAssessment,
  type AnswerCoverageInferencePort,
} from "./contracts.js";

const modelOutputSchema = z.object({
  classification: z.enum(classificationValues),
  // Strict providers reject conditional null schemas. The focus is required for
  // every classification; only unresolved classifications persist it.
  requestFocus: z.string().trim().min(1).max(REQUEST_FOCUS_MAX_LENGTH),
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
      requestFocus: { type: "string", minLength: 1, maxLength: REQUEST_FOCUS_MAX_LENGTH },
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
          schemaVersion: ANSWER_COVERAGE_SCHEMA_VERSION,
        };
      } catch {
        return { availability: "invalid" };
      }
    } catch {
      return { availability: "failed" };
    }
  }
}
