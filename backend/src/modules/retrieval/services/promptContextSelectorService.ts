import type { FinalPromptContext, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

const DEFAULT_CONTEXT_TOKEN_BUDGET = RETRIEVAL_BEHAVIOR.promptContextTokenBudget;
const DEFAULT_MAX_CONTEXTS_PER_DOCUMENT = 2;

export class PromptContextSelectorService {
  constructor(private readonly tokenBudget: number = DEFAULT_CONTEXT_TOKEN_BUDGET) {}

  select(input: {
    contexts: RerankedCandidate[];
    topK: number;
  }): FinalPromptContext[] {
    const selected: FinalPromptContext[] = [];
    const selectedChunkIds = new Set<string>();
    const seenNormalizedContents = new Set<string>();
    const documentCounts = new Map<string, number>();
    let consumed = 0;

    if (input.topK <= 0) {
      return selected;
    }

    const trySelect = (context: RerankedCandidate, allowSiblingContext: boolean): boolean => {
      if (selected.length >= input.topK || selectedChunkIds.has(context.chunkId)) {
        return false;
      }

      const documentKey = this.buildDocumentKey(context);
      const documentCount = documentCounts.get(documentKey) ?? 0;
      if (documentCount > 0 && !allowSiblingContext) {
        return false;
      }

      if (documentCount >= DEFAULT_MAX_CONTEXTS_PER_DOCUMENT) {
        return false;
      }

      const duplicateKey = this.buildDuplicateKey(context.content);
      if (duplicateKey && seenNormalizedContents.has(duplicateKey)) {
        return false;
      }

      const estimatedTokenCost = this.estimateTokenCost(context.content);
      if (estimatedTokenCost > this.tokenBudget) {
        return false;
      }

      if (consumed + estimatedTokenCost > this.tokenBudget) {
        return false;
      }

      consumed += estimatedTokenCost;
      selectedChunkIds.add(context.chunkId);
      documentCounts.set(documentKey, documentCount + 1);
      if (duplicateKey) {
        seenNormalizedContents.add(duplicateKey);
      }
      selected.push({
        ...context,
        promptPosition: selected.length,
        estimatedTokenCost,
      });
      return true;
    };

    for (const context of input.contexts) {
      trySelect(context, false);
      if (selected.length >= input.topK) {
        return selected;
      }
    }

    for (const context of input.contexts) {
      trySelect(context, true);
      if (selected.length >= input.topK) {
        return selected;
      }
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

  private buildDocumentKey(context: RerankedCandidate): string {
    return context.documentId || context.title;
  }
}
