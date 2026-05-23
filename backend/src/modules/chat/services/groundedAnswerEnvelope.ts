import type { ChatSuggestionKind } from "../types/chatResponses.js";

export const SUGGESTIONS_SENTINEL = "<<<RADIOSO_FOLLOWUPS_JSON>>>";

export interface PlannedEnvelopeSuggestion {
  text: string;
  kind: ChatSuggestionKind;
  contextIndex: number;
}

export interface GroundedAnswerEnvelope {
  answer: string;
  suggestions: PlannedEnvelopeSuggestion[];
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeKind = (value: unknown): ChatSuggestionKind | null => {
  if (value === "deeper" || value === undefined) {
    return "deeper";
  }
  return value === "broader" ? "broader" : null;
};

const readSuggestionsArray = (raw: unknown): PlannedEnvelopeSuggestion[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? normalizeWhitespace(record.text) : "";
    const kind = normalizeKind(record.kind);
    const rawIndex = typeof record.contextIndex === "number" ? Math.trunc(record.contextIndex) : NaN;
    if (!text || !kind || !Number.isInteger(rawIndex) || rawIndex < 1) {
      return [];
    }
    return [{ text, kind, contextIndex: rawIndex }];
  });
};

const parseSuggestionsBuffer = (buffer: string): PlannedEnvelopeSuggestion[] => {
  const trimmed = buffer.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return readSuggestionsArray(parsed);
  }
  if (parsed && typeof parsed === "object" && "suggestions" in parsed) {
    return readSuggestionsArray((parsed as { suggestions?: unknown }).suggestions);
  }
  return [];
};

export const parseGroundedAnswerEnvelope = (raw: string): GroundedAnswerEnvelope => {
  const sentinelIndex = raw.indexOf(SUGGESTIONS_SENTINEL);
  if (sentinelIndex === -1) {
    return { answer: raw.trim(), suggestions: [] };
  }
  const answer = raw.slice(0, sentinelIndex).trim();
  const suggestionsBuffer = raw.slice(sentinelIndex + SUGGESTIONS_SENTINEL.length);
  return { answer, suggestions: parseSuggestionsBuffer(suggestionsBuffer) };
};

const SENTINEL_HOLDBACK = SUGGESTIONS_SENTINEL.length - 1;

export interface ReaderFinalizeResult {
  trailingAnswer: string;
  fullAnswer: string;
  suggestions: PlannedEnvelopeSuggestion[];
}

/**
 * Incrementally splits a streamed LLM response into the markdown answer body and
 * the suggestions JSON that follows {@link SUGGESTIONS_SENTINEL}. While the
 * sentinel has not been observed, push() returns answer text that's safe to
 * forward to the user, holding back the trailing bytes that could form the
 * sentinel. After the sentinel is observed, push() returns "" and all further
 * input is buffered as suggestions JSON to parse on finalize().
 */
export class GroundedAnswerEnvelopeReader {
  private buffer = "";
  private suggestionsBuffer = "";
  private inSuggestions = false;
  private emittedAnswer = "";

  push(chunk: string): string {
    if (!chunk) {
      return "";
    }
    if (this.inSuggestions) {
      this.suggestionsBuffer += chunk;
      return "";
    }

    this.buffer += chunk;
    const sentinelIndex = this.buffer.indexOf(SUGGESTIONS_SENTINEL);
    if (sentinelIndex !== -1) {
      const answerPortion = this.buffer.slice(0, sentinelIndex);
      this.suggestionsBuffer = this.buffer.slice(sentinelIndex + SUGGESTIONS_SENTINEL.length);
      this.buffer = "";
      this.inSuggestions = true;
      this.emittedAnswer += answerPortion;
      return answerPortion;
    }

    if (this.buffer.length <= SENTINEL_HOLDBACK) {
      return "";
    }

    const releaseLength = this.buffer.length - SENTINEL_HOLDBACK;
    const safeText = this.buffer.slice(0, releaseLength);
    this.buffer = this.buffer.slice(releaseLength);
    this.emittedAnswer += safeText;
    return safeText;
  }

  finalize(): ReaderFinalizeResult {
    if (this.inSuggestions) {
      return {
        trailingAnswer: "",
        fullAnswer: this.emittedAnswer,
        suggestions: parseSuggestionsBuffer(this.suggestionsBuffer),
      };
    }
    const trailingAnswer = this.buffer;
    this.emittedAnswer += this.buffer;
    this.buffer = "";
    return {
      trailingAnswer,
      fullAnswer: this.emittedAnswer,
      suggestions: [],
    };
  }
}
