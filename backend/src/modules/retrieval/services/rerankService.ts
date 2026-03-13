import type { RetrievedChunk } from "../infra/vectorSearch.js";

export class RerankService {
  rerank(input: {
    query: string;
    contexts: RetrievedChunk[];
    enabled: boolean;
    topK: number;
  }): RetrievedChunk[] {
    if (!input.enabled) {
      return input.contexts;
    }

    const terms = new Set(
      input.query
        .toLowerCase()
        .split(/\W+/)
        .filter(Boolean),
    );

    return [...input.contexts]
      .sort((a, b) => this.score(b.content, terms) - this.score(a.content, terms))
      .slice(0, input.topK);
  }

  private score(content: string, terms: Set<string>): number {
    const lower = content.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (lower.includes(term)) {
        score += 1;
      }
    }

    return score;
  }
}
