import { AppError } from "../../../shared/domain/errors.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import { isPermanentProviderFailure } from "../../../shared/infra/llm/providerErrors.js";
import type { ReasoningEffort, TextGenerationResult } from "../../../shared/infra/llm/providerTypes.js";
import {
  EnrichmentProviderError,
  EnrichmentReplyUnreadableError,
  type DocumentEnrichmentGateway,
  type DocumentEnrichmentRequest,
} from "../domain/enrichment/enrichmentGateway.js";

const MAX_OUTPUT_TOKENS = 2_000;
const REASONING_EFFORT: ReasoningEffort = "low";
// A reply cut off at the cap spent it deliberating; the retry deliberates less
// within the same cap rather than buying more output.
const REASONING_EFFORT_AFTER_TRUNCATION: ReasoningEffort = "minimal";

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

/** Reads the reply as JSON, naming what went wrong without repeating any of it. */
const readReply = (result: TextGenerationResult): unknown => {
  const text = stripJsonFence(result.text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (result.stopReason === "output_limit") {
      throw new EnrichmentReplyUnreadableError("truncated");
    }
    throw new EnrichmentReplyUnreadableError(text ? "not_json" : "empty");
  }
};

// Local refusals (the input budget, a misconfigured provider) are AppErrors and
// fail the same way every time; so do the provider's own permanent rejections.
const isRetryableTransportFailure = (error: unknown): boolean =>
  !(error instanceof AppError) && !isPermanentProviderFailure(error);

export class ModelDocumentEnrichmentGateway implements DocumentEnrichmentGateway {
  constructor(private readonly pipeline: ModelInferencePipeline) {}

  async generate(request: DocumentEnrichmentRequest): Promise<{ model: string; output: unknown }> {
    const attemptKey = `document-enrichment:${request.documentId}:${request.documentRevision}`;
    let result: TextGenerationResult;
    try {
      result = await this.pipeline.complete({
        prompt: request.documentRepresentation,
        systemPrompt: request.prompt,
        temperature: 0,
        reasoningEffort: request.retry?.after === "truncated" ? REASONING_EFFORT_AFTER_TRUNCATION : REASONING_EFFORT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseFormat: {
          type: "json_schema",
          name: "document_enrichment",
          strict: true,
          schema: request.outputSchema,
        },
        operation: {
          workspaceId: request.workspaceId,
          requestId: request.documentId,
          surface: "documents",
          operation: "document_enrichment",
          // Distinct per attempt, so a retry's usage is recorded rather than deduplicated.
          attemptKey: request.retry ? `${attemptKey}:retry` : attemptKey,
        },
      });
    } catch (error) {
      throw new EnrichmentProviderError({ retryable: isRetryableTransportFailure(error), cause: error });
    }

    return { model: this.pipeline.metadata.model, output: readReply(result) };
  }
}
