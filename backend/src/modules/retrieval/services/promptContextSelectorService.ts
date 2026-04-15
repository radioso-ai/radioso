import type { FinalPromptContext, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

const DEFAULT_CONTEXT_TOKEN_BUDGET = RETRIEVAL_BEHAVIOR.promptContextTokenBudget;

export class PromptContextSelectorService {
  constructor(private readonly tokenBudget: number = DEFAULT_CONTEXT_TOKEN_BUDGET) {}

  select(input: {
    contexts: RerankedCandidate[];
    topK: number;
  }): FinalPromptContext[] {
    const selected: FinalPromptContext[] = [];
    const seenNormalizedContents = new Set<string>();
    let consumed = 0;

    for (const context of input.contexts.slice(0, input.topK)) {
      const duplicateKey = this.buildDuplicateKey(context.content);
      if (duplicateKey && seenNormalizedContents.has(duplicateKey)) {
        continue;
      }

      const estimatedTokenCost = this.estimateTokenCost(context.content);
      if (estimatedTokenCost > this.tokenBudget) {
        continue;
      }

      if (consumed + estimatedTokenCost > this.tokenBudget) {
        continue;
      }

      consumed += estimatedTokenCost;
      if (duplicateKey) {
        seenNormalizedContents.add(duplicateKey);
      }
      selected.push({
        ...context,
        promptPosition: selected.length,
        estimatedTokenCost,
      });
    }

    return selected;
  }

  private estimateTokenCost(content: string): number {
    return Math.max(1, Math.ceil(content.length / 4));
  }

  private buildDuplicateKey(content: string): string {
    return content
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
}
