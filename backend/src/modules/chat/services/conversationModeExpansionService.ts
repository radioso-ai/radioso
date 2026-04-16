import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

interface ExpansionContext {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
}

export interface ConversationModeExpansionInput {
  query: string;
  conversationMode: ConversationMode;
  brevityOverrideRequested: boolean;
  groundedAnswerSupported: boolean;
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  contexts: ExpansionContext[];
  citationDisplayEnabled: boolean;
}

export interface ConversationModeExpansionResult {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

interface PlannedSuggestion {
  label: string;
  citation: ChatCitation;
}

const splitWords = (value: string): string[] =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);

const cleanTitle = (title: string): string =>
  title
    .replace(/\s+-\s+Ananda\b.*$/i, "")
    .replace(/\s+-\s+Autrice\b.*$/i, "")
    .replace(/\s+-\s+Meditazione\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

const isQueryLikeTitle = (title: string, query: string): boolean => {
  const titleTerms = splitWords(cleanTitle(title));
  const queryTerms = splitWords(query);

  if (titleTerms.length === 0 || queryTerms.length === 0) {
    return false;
  }

  return titleTerms.length === queryTerms.length && titleTerms.every((term, index) => term === queryTerms[index]);
};

export class ConversationModeExpansionService {
  apply(input: ConversationModeExpansionInput): ConversationModeExpansionResult {
    if (
      input.brevityOverrideRequested ||
      !input.groundedAnswerSupported ||
      input.conversationMode === "factual" ||
      input.contexts.length === 0
    ) {
      return {
        answer: input.answer,
        citations: input.citations,
        answerSegments: input.answerSegments,
      };
    }

    const maxSuggestions = input.conversationMode === "exploratory" ? 3 : 2;
    const existingDocumentIds = new Set((input.citations ?? []).map((citation) => citation.documentId));
    const planned = this.planSuggestions(input.query, input.contexts, existingDocumentIds, maxSuggestions);

    if (planned.length === 0) {
      return {
        answer: input.answer,
        citations: input.citations,
        answerSegments: input.answerSegments,
      };
    }

    const baseAnswer = input.answer.trimEnd();
    const expandedAnswer = [
      baseAnswer,
      "",
      ...planned.map((suggestion) => `- ${suggestion.label}.`),
    ].join("\n");

    if (!input.citationDisplayEnabled) {
      return {
        answer: expandedAnswer,
      };
    }

    const citations = [...(input.citations ?? [])];
    const citationIndexByDocumentId = new Map<string, number>();
    citations.forEach((citation, index) => {
      citationIndexByDocumentId.set(citation.documentId, index);
    });

    const answerSegments = [...(input.answerSegments ?? [{ text: baseAnswer }])];
    answerSegments.push({ text: "\n\n" });

    for (const suggestion of planned) {
      let citationIndex = citationIndexByDocumentId.get(suggestion.citation.documentId);
      if (citationIndex === undefined) {
        citationIndex = citations.length;
        citations.push(suggestion.citation);
        citationIndexByDocumentId.set(suggestion.citation.documentId, citationIndex);
      }

      answerSegments.push({
        text: `- ${suggestion.label}.`,
        citationIndices: [citationIndex],
      });
      answerSegments.push({ text: "\n" });
    }

    const lastSegment = answerSegments[answerSegments.length - 1];
    if (lastSegment && !lastSegment.citationIndices) {
      lastSegment.text = "";
      if (lastSegment.text.length === 0) {
        answerSegments.pop();
      }
    }

    return {
      answer: expandedAnswer,
      citations,
      answerSegments,
    };
  }

  private planSuggestions(
    query: string,
    contexts: ExpansionContext[],
    existingDocumentIds: Set<string>,
    maxSuggestions: number,
  ): PlannedSuggestion[] {
    const seenLabels = new Set<string>();
    const suggestions: PlannedSuggestion[] = [];
    const adjacentContexts = contexts.filter((context) => !existingDocumentIds.has(context.documentId));

    for (const context of adjacentContexts) {
      if (suggestions.length >= maxSuggestions) {
        break;
      }

      const label = cleanTitle(context.title);
      if (!label || seenLabels.has(label.toLowerCase()) || isQueryLikeTitle(label, query)) {
        continue;
      }

      suggestions.push({
        label,
        citation: {
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
        },
      });
      seenLabels.add(label.toLowerCase());
    }

    return suggestions;
  }
}
