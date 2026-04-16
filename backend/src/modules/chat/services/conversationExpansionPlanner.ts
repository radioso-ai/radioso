import type { ChatCitation } from "./answerPresentationService.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

export interface ConversationExpansionContext {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
}

export interface ConversationExpansionSuggestion {
  documentId: string;
  chunkId: string;
  title: string;
  excerpt: string;
  resultNumber: number;
}

export interface ConversationExpansionPlan {
  conversationMode: ConversationMode;
  applied: boolean;
  style: "none" | "focused" | "expansive";
  suggestions: ConversationExpansionSuggestion[];
  followUpQuestion?: string;
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const summarizeContent = (value: string): string => {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= 110) {
    return normalized;
  }

  const sentence = normalized.match(/^(.{1,110}?[.!?])(?:\s|$)/)?.[1];
  if (sentence) {
    return sentence.trim();
  }

  return `${normalized.slice(0, 107).trimEnd()}...`;
};

const uniqueByDocument = (contexts: ConversationExpansionContext[]) => {
  const seen = new Set<string>();
  return contexts.filter((context) => {
    if (seen.has(context.documentId)) {
      return false;
    }
    seen.add(context.documentId);
    return true;
  });
};

export class ConversationExpansionPlanner {
  plan(input: {
    conversationMode: ConversationMode;
    brevityOverrideRequested: boolean;
    contexts: ConversationExpansionContext[];
    usedCitations?: ChatCitation[];
  }): ConversationExpansionPlan {
    if (input.brevityOverrideRequested || input.conversationMode === "factual") {
      return {
        conversationMode: input.conversationMode,
        applied: false,
        style: "none",
        suggestions: [],
      };
    }

    const usedDocumentIds = new Set((input.usedCitations ?? []).map((citation) => citation.documentId));
    const uniqueContexts = uniqueByDocument(input.contexts);
    if (uniqueContexts.length <= 1) {
      return {
        conversationMode: input.conversationMode,
        applied: false,
        style: "none",
        suggestions: [],
      };
    }
    const preferred = uniqueContexts.filter((context) => !usedDocumentIds.has(context.documentId));
    const candidates = preferred;
    const maxSuggestions = input.conversationMode === "guided" ? 2 : 3;
    const selected = candidates.slice(0, maxSuggestions).map((context) => ({
      documentId: context.documentId,
      chunkId: context.chunkId,
      title: context.title.trim() || "Untitled document",
      excerpt: summarizeContent(context.content),
      resultNumber: input.contexts.findIndex((candidate) => candidate.chunkId === context.chunkId) + 1,
    })).filter((context) => context.resultNumber > 0 && context.excerpt.length > 0);

    if (selected.length === 0) {
      return {
        conversationMode: input.conversationMode,
        applied: false,
        style: "none",
        suggestions: [],
      };
    }

    const followUpQuestion = input.conversationMode === "exploratory"
      ? this.buildFollowUpQuestion(selected)
      : undefined;

    return {
      conversationMode: input.conversationMode,
      applied: true,
      style: input.conversationMode === "guided" ? "focused" : "expansive",
      suggestions: selected,
      followUpQuestion,
    };
  }

  private buildFollowUpQuestion(suggestions: ConversationExpansionSuggestion[]): string | undefined {
    if (suggestions.length >= 2) {
      return `If helpful, I can compare ${suggestions[0]!.title} and ${suggestions[1]!.title} next.`;
    }

    return suggestions[0] ? `If helpful, I can dig further into ${suggestions[0].title} next.` : undefined;
  }
}
