import type OpenAI from "openai";

import type { RetrievedCandidate, RerankedCandidate, RerankStatus } from "../domain/retrievalPipelineTypes.js";

export interface RerankGateway {
  rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
  }): Promise<Array<{ chunkId: string; relevanceScore: number }>>;
}

export class OpenAISemanticRerankGateway implements RerankGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async rerank(input: {
    query: string;
    contexts: RetrievedCandidate[];
  }): Promise<Array<{ chunkId: string; relevanceScore: number }>> {
    const candidates = input.contexts
      .map((context, index) => `${index + 1}. ${context.chunkId} | ${context.title} | ${context.content.slice(0, 500)}`)
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            'Score each candidate chunk for answer relevance to the query. Return only valid JSON as an array of objects with keys "chunkId" and "relevanceScore" where relevanceScore is between 0 and 1.',
        },
        {
          role: "user",
          content: `Query:\n${input.query}\n\nCandidates:\n${candidates}`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "[]";
    return parseRerankScores(content);
  }
}

export class RerankService {
  constructor(private readonly gateway?: RerankGateway) {}

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
      const scores = await this.gateway?.rerank({
        query: input.query,
        contexts: input.contexts,
      });

      const validScores = sanitizeScores(scores);
      if (validScores.length === 0) {
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
    } catch {
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
