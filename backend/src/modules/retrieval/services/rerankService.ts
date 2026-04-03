import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { RetrievedCandidate, RerankedCandidate, RerankStatus } from "../domain/retrievalPipelineTypes.js";

export interface RerankGateway {
  rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
  }): Promise<Array<{ chunkId: string; relevanceScore: number }>>;
}

export class ModelRerankGateway implements RerankGateway {
  private static readonly TEMPERATURE = 0.2;
  private static readonly MAX_COMPLETION_TOKENS = 100;

  constructor(
    private readonly client: TextGenerationClient,
    private readonly logger?: AppLogger,
  ) {}

  async rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
  }): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    const candidates = buildRerankCandidateList(input.contexts);

    const content = await this.client.complete({
      systemPrompt:
        'Score each candidate chunk for answer relevance to the query. Return only valid JSON as an array of objects with keys "chunkId" and "relevanceScore" where relevanceScore is between 0 and 1.',
      prompt: `Query:\n${input.query}\n\nCandidates:\n${candidates}`,
      temperature: ModelRerankGateway.TEMPERATURE,
      maxOutputTokens: ModelRerankGateway.MAX_COMPLETION_TOKENS,
    });

    try {
      return parseRerankScores(content);
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
  private static readonly TEMPERATURE = 0.2;
  private static readonly MIN_OUTPUT_TOKENS = 200;
  private static readonly MAX_OUTPUT_TOKENS = 1200;
  private static readonly OUTPUT_TOKENS_PER_CANDIDATE = 24;
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
        }): Promise<{ output_text?: string; status?: string | null }>;
      };
    },
    private readonly model: string,
    private readonly logger?: AppLogger,
  ) {}

  async rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
  }): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    const candidates = buildRerankCandidateList(input.contexts);
    const maxOutputTokens = Math.min(
      OpenAISemanticRerankGateway.MAX_OUTPUT_TOKENS,
      Math.max(
        OpenAISemanticRerankGateway.MIN_OUTPUT_TOKENS,
        input.contexts.length * OpenAISemanticRerankGateway.OUTPUT_TOKENS_PER_CANDIDATE,
      ),
    );

    const response = await this.client.responses.create({
      model: this.model,
      temperature: OpenAISemanticRerankGateway.TEMPERATURE,
      max_output_tokens: maxOutputTokens,
      instructions:
        'Score each candidate chunk for answer relevance to the query. Return only JSON matching the provided schema. Use candidateIndex values from the numbered list. relevanceScore must be between 0 and 1.',
      input: `Query:\n${input.query}\n\nCandidates:\n${candidates}`,
      text: {
        format: OpenAISemanticRerankGateway.RESPONSE_FORMAT,
      },
    });

    const content = response.output_text?.trim() ?? "";
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

    const parsedScores = parseIndexedRerankScores(content || '{"scores":[]}');
    return parsedScores
      .map((score) => {
        const context = input.contexts[score.candidateIndex - 1];
        if (!context) {
          return null;
        }

        return {
          chunkId: context.chunkId,
          relevanceScore: score.relevanceScore,
        };
      })
      .filter((score): score is { chunkId: string; relevanceScore: number } => score !== null);
  }
}

export class RerankService {
  private static readonly MAX_RERANK_BATCH_SIZE = 20;

  constructor(
    private readonly gateway?: RerankGateway,
    private readonly logger?: AppLogger,
  ) {}

  async rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
    enabled: boolean;
    topK: number;
    }): Promise<{ contexts: RerankedCandidate[]; status: RerankStatus }> {
    if (!input.enabled) {
      return {
        contexts: this.bySimilarity(input.contexts, input.topK),
        status: "skipped",
      };
    }

    try {
      const rerankBatches = chunkContexts(input.contexts, RerankService.MAX_RERANK_BATCH_SIZE);
      const batchScores = await Promise.all(
        rerankBatches.map((contexts) =>
          this.gateway?.rerank({
            query: input.query,
            contexts,
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
          rerankBatchCount: Math.ceil(input.contexts.length / RerankService.MAX_RERANK_BATCH_SIZE),
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

const MAX_RERANK_RETRIEVAL_TEXT_CHARS = 220;

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

const parseRerankScores = (content: string): Array<{ chunkId: string; relevanceScore: number }> => {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = JSON.parse(normalized) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as Array<{ chunkId: string; relevanceScore: number }>;
  }

  if (parsed && typeof parsed === "object") {
    const objectResult = parsed as { results?: unknown; scores?: unknown };
    if (Array.isArray(objectResult.results)) {
      return objectResult.results as Array<{ chunkId: string; relevanceScore: number }>;
    }
    if (Array.isArray(objectResult.scores)) {
      return objectResult.scores as Array<{ chunkId: string; relevanceScore: number }>;
    }
  }

  return [];
};

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
