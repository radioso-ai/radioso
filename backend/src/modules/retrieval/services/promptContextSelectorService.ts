import type { FinalPromptContext, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";

const DEFAULT_CONTEXT_TOKEN_BUDGET = 1200;

export class PromptContextSelectorService {
  constructor(private readonly tokenBudget: number = DEFAULT_CONTEXT_TOKEN_BUDGET) {}

  select(input: {
    contexts: RerankedCandidate[];
    topK: number;
  }): FinalPromptContext[] {
    const selected: FinalPromptContext[] = [];
    let consumed = 0;

    for (const context of input.contexts.slice(0, input.topK)) {
      const estimatedTokenCost = this.estimateTokenCost(context.content);
      if (estimatedTokenCost > this.tokenBudget) {
        continue;
      }

      if (consumed + estimatedTokenCost > this.tokenBudget) {
        continue;
      }

      consumed += estimatedTokenCost;
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
}
