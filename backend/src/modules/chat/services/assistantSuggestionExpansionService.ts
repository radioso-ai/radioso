import type { ChatSuggestion, ChatSuggestionKind } from "../types/chatResponses.js";
import type { PlannedEnvelopeSuggestion } from "./groundedAnswerEnvelope.js";

interface ExpansionContext {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
}

export interface AssistantSuggestionExpansionInput {
  query: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  groundedAnswerSupported: boolean;
  answer: string;
  contexts: ExpansionContext[];
  plannedSuggestions: PlannedEnvelopeSuggestion[];
}

export interface AssistantSuggestionExpansionResult {
  suggestions?: ChatSuggestion[];
}

interface PlannedSuggestion {
  text: string;
  kind: ChatSuggestionKind;
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

const buildCharacterNgrams = (value: string, size: number): Set<string> => {
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

const calculateSetSimilarity = (left: Set<string>, right: Set<string>): number => {
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

const calculateCoverage = (candidate: Set<string>, reference: Set<string>): number => {
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

const isNearDuplicateSuggestion = (suggestionText: string, query: string, answer: string): boolean => {
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

  // Only flag suggestions that paraphrase the user's question. A grounded follow-up
  // necessarily shares topic vocabulary with the answer ("List more Shivani videos"
  // after an answer about Shivani's videos is exactly what users want), so answer-side
  // term overlap is not a duplicate signal. Literal restatements of the answer are
  // already caught by the substring check above.
  const suggestionTrigrams = buildCharacterNgrams(suggestionText, 3);
  const suggestionTerms = extractComparableTerms(suggestionText);
  const queryTerms = extractComparableTerms(query);
  const queryTermCoverage = calculateCoverage(suggestionTerms, queryTerms);
  const querySimilarity = calculateSetSimilarity(suggestionTrigrams, buildCharacterNgrams(query, 3));

  return queryTermCoverage >= 0.6 || querySimilarity >= 0.45;
};

export class AssistantSuggestionExpansionService {
  apply(input: AssistantSuggestionExpansionInput): AssistantSuggestionExpansionResult {
    if (
      !input.groundedAnswerSupported ||
      !input.suggestedQuestionsEnabled ||
      input.contexts.length === 0 ||
      input.plannedSuggestions.length === 0
    ) {
      return {};
    }

    const maxSuggestions = input.suggestedQuestionsCount;
    if (maxSuggestions <= 0) {
      return {};
    }

    const suggestions = this.planSuggestions(
      input.plannedSuggestions,
      input.contexts,
      maxSuggestions,
      input.query,
      input.answer,
    );
    return suggestions.length > 0 ? { suggestions } : {};
  }

  private planSuggestions(
    plannedSuggestions: PlannedSuggestion[],
    contexts: ExpansionContext[],
    maxSuggestions: number,
    query: string,
    answer: string,
  ): ChatSuggestion[] {
    const contextByIndex = new Map(contexts.map((context, index) => [index + 1, context]));
    const seenTexts = new Set<string>();
    const validatedSuggestions: ChatSuggestion[] = [];

    for (const candidate of plannedSuggestions) {
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

      validatedSuggestions.push({
        text: normalizeWhitespace(candidate.text),
        kind: candidate.kind,
        citation: {
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
        },
      });
      seenTexts.add(normalizedText);
    }

    return this.selectSuggestions(validatedSuggestions, maxSuggestions);
  }

  private selectSuggestions(suggestions: ChatSuggestion[], maxSuggestions: number): ChatSuggestion[] {
    if (suggestions.length <= maxSuggestions) {
      return suggestions;
    }

    if (maxSuggestions < 2) {
      return suggestions.slice(0, maxSuggestions);
    }

    const firstDeeper = suggestions.find((suggestion) => suggestion.kind === "deeper");
    const firstBroader = suggestions.find((suggestion) => suggestion.kind === "broader");

    if (!firstDeeper || !firstBroader) {
      return suggestions.slice(0, maxSuggestions);
    }

    const selected: ChatSuggestion[] = [firstDeeper, firstBroader];

    for (const suggestion of suggestions) {
      if (selected.length >= maxSuggestions) {
        break;
      }

      if (selected.includes(suggestion)) {
        continue;
      }

      selected.push(suggestion);
    }

    return selected;
  }
}
