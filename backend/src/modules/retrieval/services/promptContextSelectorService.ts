import type { FinalPromptContext, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

const DEFAULT_CONTEXT_TOKEN_BUDGET = RETRIEVAL_BEHAVIOR.promptContextTokenBudget;
const DEFAULT_MAX_CONTEXTS_PER_DOCUMENT = 2;
const DEFAULT_MAX_CHARS_PER_CONTEXT = RETRIEVAL_BEHAVIOR.promptContextMaxCharsPerContext;
const DEFAULT_MIN_USEFUL_CHARS = RETRIEVAL_BEHAVIOR.promptContextMinUsefulChars;

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

    const trySelect = (
      context: RerankedCandidate,
      options: { allowSiblingContext: boolean; allowLowInformation: boolean },
    ): boolean => {
      if (selected.length >= input.topK || selectedChunkIds.has(context.chunkId)) {
        return false;
      }

      if (!options.allowLowInformation && this.isLowInformationContext(context.content)) {
        return false;
      }

      const documentKey = this.buildDocumentKey(context);
      const documentCount = documentCounts.get(documentKey) ?? 0;
      if (documentCount > 0 && !options.allowSiblingContext) {
        return false;
      }

      if (documentCount >= DEFAULT_MAX_CONTEXTS_PER_DOCUMENT) {
        return false;
      }

      const duplicateKey = this.buildDuplicateKey(context.content);
      if (duplicateKey && seenNormalizedContents.has(duplicateKey)) {
        return false;
      }

      const packedContent = this.packContent(context.content);
      const estimatedTokenCost = this.estimateTokenCost(packedContent);
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
        content: packedContent,
        promptPosition: selected.length,
        estimatedTokenCost,
      });
      return true;
    };

    for (const context of input.contexts) {
      trySelect(context, { allowSiblingContext: false, allowLowInformation: false });
      if (selected.length >= input.topK) {
        return selected;
      }
    }

    for (const context of input.contexts) {
      trySelect(context, { allowSiblingContext: true, allowLowInformation: false });
      if (selected.length >= input.topK) {
        return selected;
      }
    }

    if (selected.length < input.topK) {
      for (const context of input.contexts) {
        trySelect(context, { allowSiblingContext: true, allowLowInformation: true });
        if (selected.length >= input.topK) {
          return selected;
        }
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
    const titleKey = context.title.replace(/\s+/g, " ").trim().toLowerCase();
    return titleKey ? `title:${titleKey}` : `document:${context.documentId}`;
  }

  private packContent(content: string): string {
    const normalized = content.trim();
    if (normalized.length <= DEFAULT_MAX_CHARS_PER_CONTEXT) {
      return normalized;
    }

    const candidate = normalized.slice(0, DEFAULT_MAX_CHARS_PER_CONTEXT);
    const lastWhitespace = candidate.lastIndexOf(" ");
    const excerpt = lastWhitespace > DEFAULT_MAX_CHARS_PER_CONTEXT * 0.75
      ? candidate.slice(0, lastWhitespace)
      : candidate;
    return `${excerpt.trimEnd()}...`;
  }

  private isLowInformationContext(content: string): boolean {
    const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.length < DEFAULT_MIN_USEFUL_CHARS) {
      return true;
    }

    return [
      "back to all events",
      "back to all",
      "skip to content",
      "vai al contenuto",
    ].some((fragment) => normalized === fragment || normalized.startsWith(`${fragment} `));
  }
}
