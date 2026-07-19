import type { ChatSuggestionKind } from "../types/chatResponses.js";

export const SUGGESTIONS_SENTINEL = "<<<RADIOSO_FOLLOWUPS_JSON>>>";

export type GroundingEnvelopeParseStatus =
  | "valid_v2"
  | "legacy_v1"
  | "missing"
  | "malformed"
  | "invalid_v2";

export type GroundingEnvelopeOutcome = "answer" | "no_support";

export interface PlannedEnvelopeSuggestion {
  text: string;
  kind: ChatSuggestionKind;
  contextIndex: number;
}

export interface GroundedAnswerEnvelope {
  answer: string;
  protocolVersion: 1 | 2 | null;
  parseStatus: GroundingEnvelopeParseStatus;
  outcome: GroundingEnvelopeOutcome | null;
  claims: unknown[][];
  suggestions: PlannedEnvelopeSuggestion[];
}

interface ParsedEnvelopeTail extends Omit<GroundedAnswerEnvelope, "answer"> {}

const emptyTail = (parseStatus: GroundingEnvelopeParseStatus): ParsedEnvelopeTail => ({
  protocolVersion: null,
  parseStatus,
  outcome: null,
  claims: [],
  suggestions: [],
});

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeKind = (value: unknown): ChatSuggestionKind | null => {
  if (value === "deeper" || value === undefined) {
    return "deeper";
  }
  return value === "broader" ? "broader" : null;
};

const readSuggestion = (entry: unknown): PlannedEnvelopeSuggestion | null => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const text = typeof record.text === "string" ? normalizeWhitespace(record.text) : "";
  const kind = normalizeKind(record.kind);
  const numericIndex = typeof record.contextIndex === "string" && /^\d+$/.test(record.contextIndex.trim())
    ? Number(record.contextIndex.trim())
    : record.contextIndex;
  const contextIndex = typeof numericIndex === "number" ? numericIndex : NaN;
  if (!text || !kind || !Number.isSafeInteger(contextIndex) || contextIndex < 1) {
    return null;
  }
  return { text, kind, contextIndex };
};

const readSuggestionsArray = (raw: unknown): PlannedEnvelopeSuggestion[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const suggestion = readSuggestion(entry);
    return suggestion ? [suggestion] : [];
  });
};

const parseEnvelopeTail = (buffer: string): ParsedEnvelopeTail => {
  const trimmed = buffer.trim();
  if (!trimmed) {
    return emptyTail("malformed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return emptyTail("malformed");
  }

  if (Array.isArray(parsed)) {
    return {
      protocolVersion: 1,
      parseStatus: "legacy_v1",
      outcome: null,
      claims: [],
      suggestions: readSuggestionsArray(parsed),
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return emptyTail("malformed");
  }

  const record = parsed as Record<string, unknown>;
  if (!("v" in record)) {
    return {
      protocolVersion: 1,
      parseStatus: "legacy_v1",
      outcome: null,
      claims: [],
      suggestions: readSuggestionsArray(record.suggestions),
    };
  }

  const isV2 = record.v === 2 || record.v === "2";
  const outcome = record.outcome === "answer" || record.outcome === "no_support"
    ? record.outcome
    : null;
  const claims = Array.isArray(record.claims) && record.claims.every(Array.isArray)
    ? record.claims
    : null;
  const suggestionsValid = Array.isArray(record.suggestions)
    && record.suggestions.every((entry) => readSuggestion(entry) !== null);
  if (!isV2 || !outcome || !claims || !suggestionsValid) {
    return {
      protocolVersion: isV2 ? 2 : null,
      parseStatus: "invalid_v2",
      outcome,
      claims: claims ?? [],
      suggestions: readSuggestionsArray(record.suggestions),
    };
  }

  return {
    protocolVersion: 2,
    parseStatus: "valid_v2",
    outcome,
    claims,
    suggestions: readSuggestionsArray(record.suggestions),
  };
};

export const parseGroundedAnswerEnvelope = (raw: string): GroundedAnswerEnvelope => {
  const sentinelIndex = raw.indexOf(SUGGESTIONS_SENTINEL);
  if (sentinelIndex === -1) {
    return { answer: raw.trim(), ...emptyTail("missing") };
  }
  const answer = raw.slice(0, sentinelIndex).trim();
  const tail = parseEnvelopeTail(raw.slice(sentinelIndex + SUGGESTIONS_SENTINEL.length));
  return { answer, ...tail };
};

// Retain enough preceding text to remove the line delimiter before a sentinel even
// when the sentinel itself is split at the earliest possible chunk boundary.
const SENTINEL_HOLDBACK = SUGGESTIONS_SENTINEL.length + 1;

export interface ReaderFinalizeResult extends Omit<GroundedAnswerEnvelope, "answer"> {
  trailingAnswer: string;
  fullAnswer: string;
}

export class GroundedAnswerEnvelopeReader {
  private buffer = "";
  private tailChunks: string[] = [];
  private inTail = false;
  private emittedAnswer = "";

  push(chunk: string): string {
    if (!chunk) {
      return "";
    }
    if (this.inTail) {
      this.tailChunks.push(chunk);
      return "";
    }

    this.buffer += chunk;
    const sentinelIndex = this.buffer.indexOf(SUGGESTIONS_SENTINEL);
    if (sentinelIndex !== -1) {
      const answerPortion = this.buffer.slice(0, sentinelIndex).replace(/\r?\n$/, "");
      const tailAfterSentinel = this.buffer.slice(sentinelIndex + SUGGESTIONS_SENTINEL.length);
      if (tailAfterSentinel) {
        this.tailChunks.push(tailAfterSentinel);
      }
      this.buffer = "";
      this.inTail = true;
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
    if (this.inTail) {
      return {
        trailingAnswer: "",
        fullAnswer: this.emittedAnswer,
        ...parseEnvelopeTail(this.tailChunks.join("")),
      };
    }

    const trailingAnswer = this.buffer;
    this.emittedAnswer += this.buffer;
    this.buffer = "";
    return {
      trailingAnswer,
      fullAnswer: this.emittedAnswer,
      ...emptyTail("missing"),
    };
  }
}
