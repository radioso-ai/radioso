import type { ChatCitation } from "./answerPresentationService.js";
import type { ChatSuggestion, ChatSuggestionKind } from "../types/chatResponses.js";

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeCitation = (value: unknown): ChatCitation | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { documentId?: unknown; chunkId?: unknown; title?: unknown };
  if (
    typeof candidate.documentId !== "string" ||
    typeof candidate.chunkId !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return undefined;
  }

  return {
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    title: candidate.title,
  };
};

export const normalizeChatSuggestionKind = (
  value: unknown,
  fallback: ChatSuggestionKind = "deeper",
): ChatSuggestionKind | null => {
  if (value === undefined) {
    return fallback;
  }

  return value === "deeper" || value === "broader" ? value : null;
};

export const normalizeChatSuggestion = (
  value: unknown,
  fallbackKind: ChatSuggestionKind = "deeper",
): ChatSuggestion | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { text?: unknown; kind?: unknown; citation?: unknown };
  if (typeof candidate.text !== "string") {
    return null;
  }

  const text = normalizeWhitespace(candidate.text);
  if (!text) {
    return null;
  }

  const kind = normalizeChatSuggestionKind(candidate.kind, fallbackKind);
  if (!kind) {
    return null;
  }

  return {
    text,
    kind,
    citation: normalizeCitation(candidate.citation),
  };
};
