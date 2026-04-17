import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ChatSuggestion } from "../types/chatResponses.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

interface ExpansionContext {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
}

type SuggestionTextGenerator = (input: { query: string; prompt: string }) => Promise<string>;

export interface ConversationModeExpansionInput {
  query: string;
  conversationMode: ConversationMode;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  brevityOverrideRequested: boolean;
  groundedAnswerSupported: boolean;
  answer: string;
  contexts: ExpansionContext[];
  citations?: Array<{ documentId: string }>;
}

export interface ConversationModeExpansionResult {
  suggestions?: ChatSuggestion[];
}

interface PlannedSuggestion {
  text: string;
  contextIndex: number;
}

interface SuggestionPromptContext extends ExpansionContext {
  contextIndex: number;
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeComparableText = (value: string): string =>
  normalizeWhitespace(
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " "),
  );

const extractComparableTerms = (value: string): Set<string> =>
  new Set(
    normalizeComparableText(value)
      .split(" ")
      .filter((token) => token.length > 0)
      .filter((token) => /^\d+$/.test(token) || token.length >= 4),
  );

const buildCharacterNgrams = (
  value: string,
  size: number,
): Set<string> => {
  const normalized = normalizeComparableText(value).replace(/\s+/g, "");

  if (normalized.length === 0) {
    return new Set();
  }

  if (normalized.length <= size) {
    return new Set([normalized]);
  }

  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }

  return grams;
};

const calculateSetSimilarity = (
  left: Set<string>,
  right: Set<string>,
): number => {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersectionCount = 0;

  for (const item of left) {
    if (right.has(item)) {
      intersectionCount += 1;
    }
  }

  return intersectionCount / (left.size + right.size - intersectionCount);
};

const calculateCoverage = (
  candidate: Set<string>,
  reference: Set<string>,
): number => {
  if (candidate.size === 0 || reference.size === 0) {
    return 0;
  }

  let overlapCount = 0;
  for (const item of candidate) {
    if (reference.has(item)) {
      overlapCount += 1;
    }
  }

  return overlapCount / candidate.size;
};

const isNearDuplicateSuggestion = (
  suggestionText: string,
  query: string,
  answer: string,
): boolean => {
  const normalizedSuggestion = normalizeComparableText(suggestionText);
  if (!normalizedSuggestion) {
    return true;
  }

  const normalizedQuery = normalizeComparableText(query);
  const normalizedAnswer = normalizeComparableText(answer);
  if (
    normalizedSuggestion === normalizedQuery ||
    normalizedSuggestion === normalizedAnswer ||
    normalizedQuery.includes(normalizedSuggestion) ||
    normalizedAnswer.includes(normalizedSuggestion)
  ) {
    return true;
  }

  const suggestionTrigrams = buildCharacterNgrams(suggestionText, 3);
  const suggestionTerms = extractComparableTerms(suggestionText);
  const queryTerms = extractComparableTerms(query);
  const answerTerms = extractComparableTerms(answer);
  const queryTermCoverage = calculateCoverage(suggestionTerms, queryTerms);
  const answerTermCoverage = calculateCoverage(suggestionTerms, answerTerms);
  const querySimilarity = calculateSetSimilarity(suggestionTrigrams, buildCharacterNgrams(query, 3));
  const answerSimilarity = calculateSetSimilarity(suggestionTrigrams, buildCharacterNgrams(answer, 3));

  return Math.max(queryTermCoverage, answerTermCoverage) >= 0.6 || Math.max(querySimilarity, answerSimilarity) >= 0.45;
};

const clampExcerpt = (value: string, maxLength: number): string => {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

const formatContextsJson = (contexts: SuggestionPromptContext[]): string =>
  JSON.stringify(
    contexts.map((context) => ({
      contextIndex: context.contextIndex,
      title: normalizeWhitespace(context.title),
      content: clampExcerpt(context.content, 600),
    })),
    null,
    2,
  );

const parseSuggestionPayload = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return JSON.parse(trimmed);
};

export class ConversationModeExpansionService {
  constructor(private readonly generateSuggestionText: SuggestionTextGenerator) {}

  async apply(input: ConversationModeExpansionInput): Promise<ConversationModeExpansionResult> {
    if (
      input.brevityOverrideRequested ||
      !input.groundedAnswerSupported ||
      input.conversationMode === "factual" ||
      !input.suggestedQuestionsEnabled ||
      input.contexts.length === 0
    ) {
      return {};
    }

    const maxSuggestions = input.suggestedQuestionsCount;
    const candidateContexts = input.contexts.slice(0, Math.max(maxSuggestions * 2, maxSuggestions));

    if (candidateContexts.length === 0) {
      return {};
    }

    const promptContexts = candidateContexts.map((context, index) => ({
      ...context,
      contextIndex: index + 1,
    }));

    try {
      const rawResponse = await this.generateSuggestionText({
        query: input.query,
        prompt: renderPromptTemplate("chat/conversation-mode-suggestions.md", {
          conversation_mode: input.conversationMode,
          max_suggestions: String(maxSuggestions),
          query: input.query,
          answer: input.answer,
          contexts_json: formatContextsJson(promptContexts),
        }),
      });

      const suggestions = this.planSuggestions(rawResponse, promptContexts, maxSuggestions, input.query, input.answer);
      return suggestions.length > 0 ? { suggestions } : {};
    } catch {
      return {};
    }
  }

  private planSuggestions(
    rawResponse: string,
    contexts: SuggestionPromptContext[],
    maxSuggestions: number,
    query: string,
    answer: string,
  ): ChatSuggestion[] {
    let parsed: unknown;
    try {
      parsed = parseSuggestionPayload(rawResponse);
    } catch {
      return [];
    }

    const candidates = this.readSuggestions(parsed);
    const contextByIndex = new Map(contexts.map((context) => [context.contextIndex, context]));
    const seenTexts = new Set<string>();
    const suggestions: ChatSuggestion[] = [];

    for (const candidate of candidates) {
      if (suggestions.length >= maxSuggestions) {
        break;
      }

      const normalizedText = normalizeComparableText(candidate.text);
      if (
        !normalizedText ||
        seenTexts.has(normalizedText) ||
        isNearDuplicateSuggestion(candidate.text, query, answer)
      ) {
        continue;
      }

      const context = contextByIndex.get(candidate.contextIndex);
      if (!context) {
        continue;
      }

      suggestions.push({
        text: normalizeWhitespace(candidate.text),
        citation: {
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
        },
      });
      seenTexts.add(normalizedText);
    }

    return suggestions;
  }

  private readSuggestions(parsed: unknown): PlannedSuggestion[] {
    if (!parsed || typeof parsed !== "object" || !("suggestions" in parsed)) {
      return [];
    }

    const rawSuggestions = (parsed as { suggestions?: unknown }).suggestions;
    if (!Array.isArray(rawSuggestions)) {
      return [];
    }

    return rawSuggestions.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const text = "text" in entry && typeof entry.text === "string" ? normalizeWhitespace(entry.text) : "";
      const contextIndex = "contextIndex" in entry && typeof entry.contextIndex === "number"
        ? Math.trunc(entry.contextIndex)
        : NaN;

      if (!text || !Number.isInteger(contextIndex) || contextIndex < 1) {
        return [];
      }

      return [{ text, contextIndex }];
    });
  }
}
