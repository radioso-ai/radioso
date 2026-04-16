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
      input.contexts.length === 0
    ) {
      return {};
    }

    const maxSuggestions = input.conversationMode === "exploratory" ? 3 : 2;
    const existingDocumentIds = new Set((input.citations ?? []).map((citation) => citation.documentId));
    const candidateContexts = input.contexts
      .filter((context) => !existingDocumentIds.has(context.documentId))
      .slice(0, Math.max(maxSuggestions * 2, maxSuggestions));

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

      const suggestions = this.planSuggestions(rawResponse, promptContexts, maxSuggestions);
      return suggestions.length > 0 ? { suggestions } : {};
    } catch {
      return {};
    }
  }

  private planSuggestions(
    rawResponse: string,
    contexts: SuggestionPromptContext[],
    maxSuggestions: number,
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
      if (!normalizedText || seenTexts.has(normalizedText)) {
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
