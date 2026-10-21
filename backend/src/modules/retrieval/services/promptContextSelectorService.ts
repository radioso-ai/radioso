import type { FinalPromptContext, RerankedCandidate } from "../domain/retrievalPipelineTypes.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

const DEFAULT_CONTEXT_TOKEN_BUDGET = RETRIEVAL_BEHAVIOR.promptContextTokenBudget;
const DEFAULT_MAX_CONTEXTS_PER_DOCUMENT = RETRIEVAL_BEHAVIOR.promptContextMaxPerDocument;
const DEFAULT_MAX_CHARS_PER_CONTEXT = RETRIEVAL_BEHAVIOR.promptContextMaxCharsPerContext;
const DEFAULT_MIN_USEFUL_CHARS = RETRIEVAL_BEHAVIOR.promptContextMinUsefulChars;

export class PromptContextSelectorService {
  constructor(private readonly tokenBudget: number = DEFAULT_CONTEXT_TOKEN_BUDGET) {}

  select(input: {
    contexts: RerankedCandidate[];
    topK: number;
  }): FinalPromptContext[] {
    return this.selectInStages([{ contexts: input.contexts, until: input.topK }]);
  }

  /**
   * Selects from each stage's contexts in turn until the whole selection reaches that stage's
   * `until`. The stages share one token budget, one count per document, and one duplicate
   * check, so a caller can set aside room for one group of contexts before another fills the
   * rest. Within a stage, each document's first passage is taken before any second one.
   */
  selectInStages(stages: ReadonlyArray<{ contexts: RerankedCandidate[]; until: number }>): FinalPromptContext[] {
    const selected: FinalPromptContext[] = [];
    const selectedChunkIds = new Set<string>();
    const seenNormalizedContents = new Set<string>();
    const documentCounts = new Map<string, number>();
    let consumed = 0;

    const trySelect = (
      context: RerankedCandidate,
      options: { allowSiblingContext: boolean; allowLowInformation: boolean },
    ): boolean => {
      if (selectedChunkIds.has(context.chunkId)) {
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

    const passes = [
      { allowSiblingContext: false, allowLowInformation: false },
      { allowSiblingContext: true, allowLowInformation: false },
      { allowSiblingContext: true, allowLowInformation: true },
    ];
    for (const stage of stages) {
      for (const pass of passes) {
        for (const context of stage.contexts) {
          if (selected.length >= stage.until) {
            break;
          }
          trySelect(context, pass);
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
