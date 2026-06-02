import { randomUUID } from "node:crypto";

import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { UsageEventRecorder, UsageEventStatus } from "../../../shared/domain/usageEventRecorder.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { ReasoningEffort } from "../../../shared/infra/llm/providerTypes.js";
import {
  isReasoningEffortKnownUnsupported,
  isUnsupportedReasoningEffortError,
  markReasoningEffortUnsupported,
} from "../../../shared/infra/llm/reasoningEffortSupport.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { RetrievedCandidate, RerankedCandidate, RerankStatus } from "../domain/retrievalPipelineTypes.js";

export interface RerankGatewayInput {
  query: string;
  contexts: RetrievedCandidate[];
  /** Reference date (UTC `YYYY-MM-DD`) the model uses to judge event recency. */
  today: string;
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext?: ModelCallUsageContext;
}

export interface RerankGateway {
  rerank(input: RerankGatewayInput): Promise<Array<{ chunkId: string; relevanceScore: number }>>;
}

const buildRerankPrompt = (input: { query: string; candidates: string; today: string }): string =>
  renderPromptTemplate("retrieval/rerank.md", input);

type RerankSamplingParams = { temperature?: number; reasoning?: { effort: ReasoningEffort } };

// OpenAI's Responses API takes a nested `reasoning.effort` rather than
// chat.completions' flat `reasoning_effort`. gpt-5 family reasoning models reject
// a non-default temperature, so send reasoning effort (no temperature) for them;
// other OpenAI rerank models keep temperature. If the model has already rejected
// the effort value, send neither so it reranks at the model default rather than
// failing. Detection/cache live in the shared (non-vendor) module so this path
// degrades the same way the chat-completions path does.
const buildRerankResponsesSamplingParams = (model: string): RerankSamplingParams => {
  if (!/^gpt-5(?:[.-]|$)/i.test(model)) {
    return { temperature: RETRIEVAL_BEHAVIOR.rerank.temperature };
  }
  const effort = RETRIEVAL_BEHAVIOR.rerank.reasoningEffort;
  return isReasoningEffortKnownUnsupported(model, effort) ? {} : { reasoning: { effort } };
};

export class ModelRerankGateway implements RerankGateway {
  constructor(
    private readonly client: ModelInferencePipeline,
    private readonly logger?: AppLogger,
  ) {}

  async rerank(input: RerankGatewayInput): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    const candidates = buildRerankCandidateList(input.contexts);

    const { text: content } = await this.client.complete({
      operation: input.usageContext ?? fallbackRerankOperation(input.workspaceContext?.workspaceId),
      prompt: buildRerankPrompt({ query: input.query, candidates, today: input.today }),
      temperature: RETRIEVAL_BEHAVIOR.rerank.temperature,
      reasoningEffort: RETRIEVAL_BEHAVIOR.rerank.reasoningEffort,
      maxOutputTokens: RETRIEVAL_BEHAVIOR.rerank.modelMaxCompletionTokens,
    });

    try {
      return mapIndexedRerankScores(input.contexts, parseIndexedRerankScores(content));
    } catch (error) {
      this.logger?.warn(
        {
          error,
          rerankModel: this.client.metadata.model,
          rerankProvider: this.client.metadata.provider,
          rerankQuery: input.query,
          candidateCount: input.contexts.length,
          rawResponsePreview: content.slice(0, 500),
        },
        "Rerank response could not be parsed; falling back to similarity ordering",
      );
      throw error;
    }
  }
}

export class OpenAISemanticRerankGateway implements RerankGateway {
  private static readonly RESPONSE_FORMAT = {
    type: "json_schema" as const,
    name: "rerank_scores",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores"],
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["candidateIndex", "relevanceScore"],
            properties: {
              candidateIndex: { type: "integer" },
              relevanceScore: { type: "number" },
            },
          },
        },
      },
    },
  };

  constructor(
    private readonly client: {
      responses: {
        create(input: {
          model: string;
          temperature?: number;
          reasoning?: { effort: ReasoningEffort };
          max_output_tokens?: number;
          instructions?: string;
          input?: string;
          text?: {
            format?: {
              type: "json_schema";
              name: string;
              strict?: boolean | null;
              schema: Record<string, unknown>;
            };
          };
        }): Promise<{
          output_text?: string;
          status?: string | null;
          usage?: {
            input_tokens?: number | null;
            output_tokens?: number | null;
            total_tokens?: number | null;
          } | null;
        }>;
      };
    },
    private readonly model: string,
    private readonly logger?: AppLogger,
    private readonly usageEventRecorder?: UsageEventRecorder,
  ) {}

  async rerank(input: RerankGatewayInput): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    const candidates = buildRerankCandidateList(input.contexts);
    const maxOutputTokens = Math.min(
      RETRIEVAL_BEHAVIOR.rerank.openAiMaxOutputTokens,
      Math.max(
        RETRIEVAL_BEHAVIOR.rerank.openAiMinOutputTokens,
        input.contexts.length * RETRIEVAL_BEHAVIOR.rerank.openAiOutputTokensPerCandidate,
      ),
    );

    const prompt = buildRerankPrompt({ query: input.query, candidates, today: input.today });
    const operation = input.usageContext ?? fallbackRerankOperation(input.workspaceContext?.workspaceId);
    const sampling = buildRerankResponsesSamplingParams(this.model);
    const createRerank = (params: RerankSamplingParams) =>
      this.client.responses.create({
        model: this.model,
        ...params,
        max_output_tokens: maxOutputTokens,
        input: prompt,
        text: {
          format: OpenAISemanticRerankGateway.RESPONSE_FORMAT,
        },
      });
    let response: Awaited<ReturnType<typeof this.client.responses.create>> | undefined;
    try {
      try {
        response = await createRerank(sampling);
      } catch (error) {
        // A reasoning-effort rejection must degrade to a real rerank at the model
        // default, not silently fall through to similarity ordering. Retry without
        // the effort and remember it so the failed round-trip is paid at most once.
        if (!sampling.reasoning || !isUnsupportedReasoningEffortError(error)) {
          throw error;
        }
        markReasoningEffortUnsupported(this.model, sampling.reasoning.effort);
        response = await createRerank({});
      }
    } catch (error) {
      await this.recordUsage({
        operation,
        prompt,
        outputText: "",
        status: "failed",
        error,
      });
      throw error;
    }

    const content = response.output_text?.trim() ?? "";
    await this.recordUsage({
      operation,
      prompt,
      outputText: content,
      status: "succeeded",
      providerUsage: response.usage ?? undefined,
    });

    if (!content) {
      this.logger?.warn(
        {
          rerankModel: this.model,
          rerankQuery: input.query,
          candidateCount: input.contexts.length,
          maxOutputTokens,
          responseStatus: response.status,
        },
        "OpenAI rerank returned empty content",
      );
    }

    return mapIndexedRerankScores(input.contexts, parseIndexedRerankScores(content || '{"scores":[]}'));
  }

  private async recordUsage(input: {
    operation: ModelCallUsageContext;
    prompt: string;
    outputText: string;
    status: UsageEventStatus;
    providerUsage?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      total_tokens?: number | null;
    };
    error?: unknown;
  }): Promise<void> {
    if (!this.usageEventRecorder) {
      return;
    }
    const inputBytes = Buffer.byteLength(input.prompt, "utf8");
    const outputBytes = Buffer.byteLength(input.outputText, "utf8");
    const inputTokens = input.providerUsage?.input_tokens ?? estimateTokens(inputBytes);
    const outputTokens = input.providerUsage?.output_tokens ?? (outputBytes > 0 ? estimateTokens(outputBytes) : 0);

    await this.usageEventRecorder.recordModelCall({
      idempotencyKey: buildUsageIdempotencyKey(input.operation, "openai", this.model, input.status),
      accountId: input.operation.accountId ?? null,
      workspaceId: input.operation.workspaceId,
      conversationId: input.operation.conversationId ?? null,
      messageId: input.operation.messageId ?? null,
      surface: input.operation.surface,
      operation: input.operation.operation,
      provider: "openai",
      model: this.model,
      inputTokens,
      outputTokens,
      totalTokens: input.providerUsage?.total_tokens ?? inputTokens + outputTokens,
      inputBytes,
      outputBytes,
      status: input.status,
      usageQuality: input.providerUsage ? "actual" : "estimated",
      providerRequestId: null,
      errorCode: input.error instanceof Error ? input.error.message.slice(0, 120) : input.error ? "model_call_failed" : null,
    }).catch(() => {});
  }
}

export class RerankService {
  constructor(
    private readonly gateway?: RerankGateway,
    private readonly logger?: AppLogger,
    private readonly clock: Clock = systemClock,
  ) {}

  async rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
    enabled: boolean;
    topK: number;
    workspaceContext?: LlmCapabilityResolveInput;
    usageContext?: Omit<ModelCallUsageContext, "operation">;
  }): Promise<{ contexts: RerankedCandidate[]; status: RerankStatus }> {
    if (!input.enabled) {
      return {
        contexts: this.bySimilarity(input.contexts, input.topK),
        status: "skipped",
      };
    }

    try {
      const today = formatIsoDateUtc(this.clock());
      const rerankBatches = chunkContexts(input.contexts, RETRIEVAL_BEHAVIOR.rerank.maxBatchSize);
      const batchScores = await Promise.all(
        rerankBatches.map((contexts, batchIndex) =>
          this.gateway?.rerank({
            query: input.query,
            contexts,
            today,
            workspaceContext: input.workspaceContext,
            usageContext: {
              ...(input.usageContext ?? fallbackUsageContext(input.workspaceContext?.workspaceId)),
              operation: "rerank",
              attemptKey: `rerank:${batchIndex}`,
            },
          }),
        ),
      );
      const scores = batchScores.flatMap((batch) => batch ?? []);

      const validScores = sanitizeScores(scores);
      if (validScores.length === 0) {
        this.logger?.warn(
          {
            rerankQuery: input.query,
            candidateCount: input.contexts.length,
            rerankCandidateCount: input.contexts.length,
            rerankBatchCount: rerankBatches.length,
          },
          "Rerank returned no valid scores; falling back to similarity ordering",
        );
        return {
          contexts: this.bySimilarity(input.contexts, input.topK),
          status: "fallback",
        };
      }

      const byChunkId = new Map(validScores.map((score) => [score.chunkId, score.relevanceScore]));
      const ranked = [...input.contexts]
        .map((context) => ({
          ...context,
          relevanceScore: byChunkId.get(context.chunkId) ?? 0,
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore || b.similarity - a.similarity)
        .slice(0, input.topK)
        .map((context, index) => ({
          ...context,
          rerankPosition: index,
        }));

      return {
        contexts: ranked,
        status: "applied",
      };
    } catch (error) {
      this.logger?.warn(
        {
          error: toLoggableError(error),
          rerankQuery: input.query,
          candidateCount: input.contexts.length,
          rerankCandidateCount: input.contexts.length,
          rerankBatchCount: Math.ceil(input.contexts.length / RETRIEVAL_BEHAVIOR.rerank.maxBatchSize),
        },
        "Rerank request failed; falling back to similarity ordering",
      );
      return {
        contexts: this.bySimilarity(input.contexts, input.topK),
        status: "fallback",
      };
    }
  }

  private bySimilarity(contexts: RetrievedCandidate[], topK: number): RerankedCandidate[] {
    return [...contexts]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK)
      .map((context, index) => ({
        ...context,
        relevanceScore: context.similarity,
        rerankPosition: index,
      }));
  }
}

const MAX_RERANK_RETRIEVAL_TEXT_CHARS = RETRIEVAL_BEHAVIOR.rerank.maxRetrievalTextChars;

const buildRerankCandidateList = (contexts: RetrievedCandidate[]): string =>
  contexts
    .map(
      (context, index) =>
        `${index + 1}. ${context.chunkId} | ${context.retrievalText.slice(0, MAX_RERANK_RETRIEVAL_TEXT_CHARS)}`,
    )
    .join("\n");

const chunkContexts = (contexts: RetrievedCandidate[], size: number): RetrievedCandidate[][] => {
  const batches: RetrievedCandidate[][] = [];
  for (let index = 0; index < contexts.length; index += size) {
    batches.push(contexts.slice(index, index + size));
  }
  return batches;
};

const toLoggableError = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    code?: unknown;
    type?: unknown;
    param?: unknown;
    request_id?: unknown;
    headers?: unknown;
    error?: unknown;
    cause?: unknown;
  };

  return {
    name: candidate.name,
    message: candidate.message,
    status: candidate.status,
    code: candidate.code,
    type: candidate.type,
    param: candidate.param,
    request_id: candidate.request_id,
    headers: candidate.headers,
    error: candidate.error,
    cause: candidate.cause,
  };
};

const estimateTokens = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

const fallbackUsageContext = (workspaceId?: string): Omit<ModelCallUsageContext, "operation"> => ({
  workspaceId: workspaceId ?? "unknown",
  requestId: randomUUID(),
  surface: "retrieval",
  attemptKey: "rerank",
});

const fallbackRerankOperation = (workspaceId?: string): ModelCallUsageContext => ({
  ...fallbackUsageContext(workspaceId),
  operation: "rerank",
});

const buildUsageIdempotencyKey = (
  context: ModelCallUsageContext,
  provider: string,
  model: string,
  status: UsageEventStatus,
): string => [
  "model",
  context.surface,
  context.operation,
  context.conversationId ?? `request:${context.requestId ?? "none"}`,
  context.messageId ?? "none",
  context.attemptKey,
  provider,
  model,
  status,
].join(":");

const parseIndexedRerankScores = (content: string): Array<{ candidateIndex: number; relevanceScore: number }> => {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = JSON.parse(normalized) as unknown;
  if (parsed && typeof parsed === "object") {
    const objectResult = parsed as { results?: unknown; scores?: unknown };
    const rawScores = Array.isArray(objectResult.results)
      ? objectResult.results
      : Array.isArray(objectResult.scores)
        ? objectResult.scores
        : [];

    return rawScores.filter(
      (score): score is { candidateIndex: number; relevanceScore: number } =>
        Boolean(
          score &&
            typeof score === "object" &&
            typeof (score as { candidateIndex?: unknown }).candidateIndex === "number" &&
            typeof (score as { relevanceScore?: unknown }).relevanceScore === "number",
        ),
    );
  }

  return [];
};

const mapIndexedRerankScores = (
  contexts: RetrievedCandidate[],
  scores: Array<{ candidateIndex: number; relevanceScore: number }>,
): Array<{ chunkId: string; relevanceScore: number }> =>
  scores
    .map((score) => {
      const context = contexts[score.candidateIndex - 1];
      if (!context) {
        return null;
      }

      return {
        chunkId: context.chunkId,
        relevanceScore: score.relevanceScore,
      };
    })
    .filter((score): score is { chunkId: string; relevanceScore: number } => score !== null);

const sanitizeScores = (
  scores?: Array<{ chunkId: string; relevanceScore: number }>,
): Array<{ chunkId: string; relevanceScore: number }> => {
  if (!scores) {
    return [];
  }

  return scores
    .filter((score): score is { chunkId: string; relevanceScore: number } => {
      return Boolean(
        score &&
          typeof score.chunkId === "string" &&
          score.chunkId.length > 0 &&
          typeof score.relevanceScore === "number" &&
          Number.isFinite(score.relevanceScore),
      );
    })
    .map((score) => ({
      chunkId: score.chunkId,
      relevanceScore: Math.max(0, Math.min(1, score.relevanceScore)),
    }));
};
