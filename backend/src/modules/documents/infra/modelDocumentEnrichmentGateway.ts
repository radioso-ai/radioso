import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { ReasoningEffort, TextGenerationResult } from "../../../shared/infra/llm/providerTypes.js";
import {
  EnrichmentProviderError,
  EnrichmentReplyUnreadableError,
  type DocumentEnrichmentGateway,
  type DocumentEnrichmentRequest,
} from "../domain/enrichment/enrichmentGateway.js";

const FIRST_ATTEMPT: { maxOutputTokens: number; reasoningEffort: ReasoningEffort } = {
  maxOutputTokens: 2_000,
  reasoningEffort: "low",
};

/**
 * A reply cut off at the cap gets one retry with twice the room, and less
 * deliberation where the provider honours a reasoning effort. Doubling is what
 * lets the retry succeed on every provider, not only those with a reasoning
 * dial. It costs only the tokens the reply uses: a cap is a ceiling, and quoted
 * facts keep a typical reply far below the first one.
 */
const TRUNCATION_RETRY: { maxOutputTokens: number; reasoningEffort: ReasoningEffort } = {
  maxOutputTokens: 4_000,
  reasoningEffort: "minimal",
};

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

/** Reads the reply as JSON, naming what went wrong without repeating any of it. */
const readReply = (result: TextGenerationResult): unknown => {
  // Checked before parsing: a forced schema tool call cut off at the limit can
  // arrive as a complete-looking `{}`, which would pass as an empty envelope.
  if (result.stopReason === "output_limit") {
    throw new EnrichmentReplyUnreadableError("truncated");
  }
  const text = stripJsonFence(result.text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EnrichmentReplyUnreadableError(text ? "not_json" : "empty");
  }
};

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
        ...(request.retry?.after === "truncated" ? TRUNCATION_RETRY : FIRST_ATTEMPT),
        responseFormat: {
          type: "json_schema",
          name: "document_enrichment",
          strict: true,
          schema: request.outputSchema,
        },
        operation: {
          workspaceId: request.workspaceId,
          requestId: request.documentId,
          documentId: request.documentId,
          documentRevision: request.documentRevision,
          surface: "documents",
          operation: "document_enrichment",
          // Distinct per attempt, so a retry's usage is recorded rather than deduplicated.
          attemptKey: request.retry ? `${attemptKey}:retry` : attemptKey,
        },
      });
    } catch (error) {
      // Transient transport failures were the adapter's to retry; what reaches
      // here is final for this run.
      throw new EnrichmentProviderError({ cause: error });
    }

    return { model: this.pipeline.metadata.model, output: readReply(result) };
  }
}
