import { describe, expect, it } from "vitest";

import {
  EnrichmentProviderError,
  EnrichmentReplyUnreadableError,
  type DocumentEnrichmentRequest,
} from "../../src/modules/documents/domain/enrichment/enrichmentGateway.js";
import { createDefaultDocumentEnrichmentStrategyRegistry } from "../../src/modules/documents/domain/enrichment/enrichmentStrategies.js";
import { ModelDocumentEnrichmentGateway } from "../../src/modules/documents/infra/modelDocumentEnrichmentGateway.js";
import { DocumentEnrichmentService } from "../../src/modules/documents/services/documentEnrichmentService.js";
import { payloadTooLarge } from "../../src/shared/domain/errors.js";
import type { ModelInferencePipeline, ModelInferenceRequest } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import { ProviderHttpError } from "../../src/shared/infra/llm/providerErrors.js";
import type { TextGenerationResult } from "../../src/shared/infra/llm/providerTypes.js";

type Completion = TextGenerationResult | { error: unknown };

/** A pipeline that returns each scripted completion in turn and records every request. */
const scriptedPipeline = (completions: Completion[]) => {
  const requests: ModelInferenceRequest[] = [];
  const pipeline = {
    metadata: { capability: "chat", provider: "openai", model: "gpt-5.4-mini" },
    async complete(request: ModelInferenceRequest) {
      requests.push(request);
      const completion = completions[requests.length - 1];
      if (!completion) {
        throw new Error("unscripted completion");
      }
      if ("error" in completion) {
        throw completion.error;
      }
      return completion;
    },
    stream() {
      throw new Error("enrichment never streams");
    },
  } as unknown as ModelInferencePipeline;
  return { pipeline, requests };
};

const OUTPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string" } } };

const request = (overrides: Partial<DocumentEnrichmentRequest> = {}): DocumentEnrichmentRequest => ({
  workspaceId: "workspace-1",
  documentId: "doc-1",
  documentRevision: 11,
  prompt: "Extract metadata",
  documentRepresentation: "Title: Example\nCreated at: 2026-07-01T00:00:00.000Z\n\nBody",
  outputSchema: OUTPUT_SCHEMA,
  ...overrides,
});

const VALID_REPLY = JSON.stringify({
  type: "event",
  confidence: 0.9,
  facts: [{ kind: "event_date", quote: "July 17-19, 2026", dateFrom: "2026-07-17", dateTo: "2026-07-19", unresolvedText: null }],
});

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof EnrichmentReplyUnreadableError ? error.reason : error;
  }
  return "resolved";
};

describe("ModelDocumentEnrichmentGateway", () => {
  it("asks for the output schema as strict structured output, scoped to the document revision", async () => {
    const { pipeline, requests } = scriptedPipeline([{ text: VALID_REPLY, stopReason: "completed" }]);

    const reply = await new ModelDocumentEnrichmentGateway(pipeline).generate(request());

    expect(reply).toMatchObject({ model: "gpt-5.4-mini", output: { type: "event" } });
    expect(requests[0]).toMatchObject({
      reasoningEffort: "low",
      maxOutputTokens: 2_000,
      responseFormat: { type: "json_schema", name: "document_enrichment", strict: true, schema: OUTPUT_SCHEMA },
      operation: expect.objectContaining({
        workspaceId: "workspace-1",
        requestId: "doc-1",
        documentId: "doc-1",
        documentRevision: 11,
        operation: "document_enrichment",
        attemptKey: "document-enrichment:doc-1:11",
      }),
    });
  });

  it("names the request settings every attempt is sent with, so a stored reply is reused only under the same ones", () => {
    const { pipeline } = scriptedPipeline([]);

    expect(JSON.parse(new ModelDocumentEnrichmentGateway(pipeline).requestProfile)).toEqual({
      temperature: 0,
      firstAttempt: { maxOutputTokens: 2_000, reasoningEffort: "low" },
      truncationRetry: { maxOutputTokens: 4_000, reasoningEffort: "minimal" },
    });
  });

  it("reads a fenced JSON reply from a provider that does not enforce the schema", async () => {
    const { pipeline } = scriptedPipeline([{ text: `\`\`\`json\n${VALID_REPLY}\n\`\`\`` }]);

    const reply = await new ModelDocumentEnrichmentGateway(pipeline).generate(request());

    expect(reply.output).toMatchObject({ type: "event", confidence: 0.9 });
  });

  it("names an unreadable reply by what went wrong, never by what it said", async () => {
    const { pipeline } = scriptedPipeline([
      { text: "   " },
      { text: VALID_REPLY.slice(0, 40), stopReason: "output_limit" },
      { text: "", stopReason: "output_limit" },
      { text: "The document is an event.", stopReason: "completed" },
    ]);
    const gateway = new ModelDocumentEnrichmentGateway(pipeline);

    expect(await reasonOf(gateway.generate(request()))).toBe("empty");
    expect(await reasonOf(gateway.generate(request()))).toBe("truncated");
    expect(await reasonOf(gateway.generate(request()))).toBe("truncated");
    const notJson = await gateway.generate(request()).catch((error: unknown) => error);
    expect(notJson).toBeInstanceOf(EnrichmentReplyUnreadableError);
    expect((notJson as EnrichmentReplyUnreadableError).reason).toBe("not_json");
    expect((notJson as Error).message).not.toContain("event");
  });

  it("treats a reply cut off at the output limit as truncated even when what arrived parses", async () => {
    // A forced schema tool call cut off at max_tokens can arrive as a complete-looking `{}`.
    const { pipeline } = scriptedPipeline([{ text: "{}", stopReason: "output_limit" }]);

    expect(await reasonOf(new ModelDocumentEnrichmentGateway(pipeline).generate(request()))).toBe("truncated");
  });

  it("retries a reply cut off at the limit with twice the output cap and less deliberation, and repeats any other", async () => {
    const { pipeline, requests } = scriptedPipeline([{ text: VALID_REPLY }, { text: VALID_REPLY }]);
    const gateway = new ModelDocumentEnrichmentGateway(pipeline);

    await gateway.generate(request({ retry: { after: "truncated" } }));
    await gateway.generate(request({ retry: { after: "unreadable" } }));

    expect(requests[0]).toMatchObject({
      reasoningEffort: "minimal",
      maxOutputTokens: 4_000,
      operation: expect.objectContaining({ attemptKey: "document-enrichment:doc-1:11:retry" }),
    });
    expect(requests[1]).toMatchObject({
      reasoningEffort: "low",
      maxOutputTokens: 2_000,
      operation: expect.objectContaining({ attemptKey: "document-enrichment:doc-1:11:retry" }),
    });
  });

  it("reports every transport failure as a content-free provider error", async () => {
    const { pipeline } = scriptedPipeline([
      { error: new ProviderHttpError({ provider: "OpenAI", operation: "chat", status: 429 }) },
      { error: new ProviderHttpError({ provider: "OpenAI", operation: "chat", status: 503 }) },
      { error: new TypeError("fetch failed") },
      { error: new ProviderHttpError({ provider: "OpenAI", operation: "chat", status: 400 }) },
      { error: new ProviderHttpError({ provider: "OpenAI", operation: "chat", status: 401 }) },
      { error: payloadTooLarge("LLM prompt exceeds maximum input token budget") },
    ]);
    const gateway = new ModelDocumentEnrichmentGateway(pipeline);

    for (let index = 0; index < 6; index += 1) {
      const error = await gateway.generate(request()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EnrichmentProviderError);
      expect((error as Error).message).toBe("enrichment_provider_error");
    }
  });
});

describe("enrichment through the model gateway", () => {
  const enrich = (pipeline: ModelInferencePipeline) =>
    new DocumentEnrichmentService({
      gateway: new ModelDocumentEnrichmentGateway(pipeline),
      strategyRegistry: createDefaultDocumentEnrichmentStrategyRegistry(),
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    }).enrich({
      document: {
        id: "doc-1",
        workspaceId: "workspace-1",
        revision: 11,
        title: "Summer workshop",
        markdownContent: "Summer workshop\n\nDates: July 17-19, 2026.",
        metadata: {},
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      chunks: [{ chunkIndex: 0, startOffset: 0, endOffset: 41, metadata: {} }],
      anchor: { source: "document_created_at", date: "2026-07-01" },
    });

  it("applies a fenced reply", async () => {
    const { pipeline } = scriptedPipeline([{ text: `\`\`\`\n${VALID_REPLY}\n\`\`\`` }]);

    const result = await enrich(pipeline);

    expect(result.status).toBe("applied");
    expect(result.chunks[0]?.metadata).toMatchObject({ dateFrom: "2026-07-17", dateTo: "2026-07-19" });
  });

  it("asks again after an empty reply", async () => {
    const { pipeline, requests } = scriptedPipeline([{ text: "", stopReason: "completed" }, { text: VALID_REPLY }]);

    const result = await enrich(pipeline);

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ status: "applied", modelAttemptCount: 2, firstAttemptFailureReason: "invalid_output: empty" });
  });

  it("never applies an empty envelope cut off at the limit, so earlier extracted dates are not cleared", async () => {
    const { pipeline, requests } = scriptedPipeline([
      { text: "{}", stopReason: "output_limit" },
      { text: "{}", stopReason: "output_limit" },
    ]);

    const result = await enrich(pipeline);

    expect(requests.map((entry) => [entry.reasoningEffort, entry.maxOutputTokens])).toEqual([["low", 2_000], ["minimal", 4_000]]);
    expect(result).toMatchObject({ status: "failed", modelAttemptCount: 2, firstAttemptFailureReason: "invalid_output: truncated" });
    expect(result.provenance.failureReason).toBe("invalid_output: truncated");
  });

  it("asks again after a reply that does not match the schema, then fails", async () => {
    const { pipeline, requests } = scriptedPipeline([{ text: "[1, 2, 3]" }, { text: "\"event\"" }, { text: VALID_REPLY }]);

    const result = await enrich(pipeline);

    expect(requests).toHaveLength(2);
    expect(result.status).toBe("failed");
    expect(result.provenance.failureReason).toBe("invalid_output: root");
  });

  it("sends the catalog's output schema with every request", async () => {
    const { pipeline, requests } = scriptedPipeline([{ text: VALID_REPLY }]);

    await enrich(pipeline);

    const schema = requests[0]?.responseFormat?.schema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toEqual(["type", "confidence", "facts"]);
  });
});
