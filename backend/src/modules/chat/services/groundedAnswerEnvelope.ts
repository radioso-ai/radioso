import type { ChatSuggestionKind } from "../types/chatResponses.js";

export const SUGGESTIONS_SENTINEL = "<<<RADIOSO_FOLLOWUPS_JSON>>>";

// The model self-reports how well the retrieved excerpts supported its answer.
// "degraded" marks an answer the model could only partially ground — it answered
// but had to hedge or note that the materials don't fully cover the question.
// We never infer this from the prose (Radioso is multilingual); it is the model's
// verdict, defaulting to "grounded" when absent or unrecognized.
export type AnswerGroundingVerdict = "grounded" | "degraded";

const DEFAULT_GROUNDING: AnswerGroundingVerdict = "grounded";

const normalizeGrounding = (value: unknown): AnswerGroundingVerdict =>
  value === "degraded" ? "degraded" : DEFAULT_GROUNDING;

export interface PlannedEnvelopeSuggestion {
  text: string;
  kind: ChatSuggestionKind;
  contextIndex: number;
}

export interface GroundedAnswerEnvelope {
  answer: string;
  grounding: AnswerGroundingVerdict;
  suggestions: PlannedEnvelopeSuggestion[];
}

interface ParsedEnvelopeTail {
  grounding: AnswerGroundingVerdict;
  suggestions: PlannedEnvelopeSuggestion[];
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

// The prompt asks the model to set kind explicitly, but it's the field most often
// omitted in early-streaming model output. Defaulting to "deeper" keeps a valid
// suggestion alive when the model drops the field; explicit "broader" still wins
// and any other value is rejected so we don't accept arbitrary kinds silently.
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

const parseEnvelopeTail = (buffer: string): ParsedEnvelopeTail => {
  const empty: ParsedEnvelopeTail = { grounding: DEFAULT_GROUNDING, suggestions: [] };
  const trimmed = buffer.trim();
  if (!trimmed) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return empty;
  }
  // The current prompt asks for an object envelope {grounding, suggestions}, but
  // a bare array remains valid (older format / providers that drop the wrapper).
  // A bare array carries no verdict, so grounding stays at the grounded default.
  if (Array.isArray(parsed)) {
    return { grounding: DEFAULT_GROUNDING, suggestions: readSuggestionsArray(parsed) };
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as { grounding?: unknown; suggestions?: unknown };
    return {
      grounding: normalizeGrounding(record.grounding),
      suggestions: readSuggestionsArray(record.suggestions),
    };
  }
  return empty;
};

export const parseGroundedAnswerEnvelope = (raw: string): GroundedAnswerEnvelope => {
  // The prompt requires the sentinel to appear on a line by itself after the
  // complete answer. We use first-occurrence indexOf rather than a stricter
  // "newline-prefixed" match because a literal sentinel inside answer prose is
  // not produced by the model in practice, and a substring search is cheaper
  // than a regex on streamed bytes. If a future prompt change ever surfaces
  // false positives, prefer requiring the sentinel be preceded by a newline.
  const sentinelIndex = raw.indexOf(SUGGESTIONS_SENTINEL);
  if (sentinelIndex === -1) {
    return { answer: raw.trim(), grounding: DEFAULT_GROUNDING, suggestions: [] };
  }
  const answer = raw.slice(0, sentinelIndex).trim();
  const tail = parseEnvelopeTail(raw.slice(sentinelIndex + SUGGESTIONS_SENTINEL.length));
  return { answer, grounding: tail.grounding, suggestions: tail.suggestions };
};

// Hold back the trailing (sentinel.length - 1) bytes of the answer buffer before
// emitting to the user: any shorter tail could still be the beginning of the
// sentinel and would split incorrectly if released. Once the full sentinel is
// observed it's stripped, so we never need to hold back more than this.
const SENTINEL_HOLDBACK = SUGGESTIONS_SENTINEL.length - 1;

export interface ReaderFinalizeResult {
  trailingAnswer: string;
  fullAnswer: string;
  grounding: AnswerGroundingVerdict;
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
  // Use a chunk array rather than concatenating onto a string to keep ingestion
  // linear in total bytes even if a future caller sends many suggestion chunks.
  private suggestionsChunks: string[] = [];
  private inSuggestions = false;
  private emittedAnswer = "";

  push(chunk: string): string {
    if (!chunk) {
      return "";
    }
    if (this.inSuggestions) {
      this.suggestionsChunks.push(chunk);
      return "";
    }

    this.buffer += chunk;
    const sentinelIndex = this.buffer.indexOf(SUGGESTIONS_SENTINEL);
    if (sentinelIndex !== -1) {
      const answerPortion = this.buffer.slice(0, sentinelIndex);
      const tailAfterSentinel = this.buffer.slice(sentinelIndex + SUGGESTIONS_SENTINEL.length);
      if (tailAfterSentinel) {
        this.suggestionsChunks.push(tailAfterSentinel);
      }
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
      const tail = parseEnvelopeTail(this.suggestionsChunks.join(""));
      return {
        trailingAnswer: "",
        fullAnswer: this.emittedAnswer,
        grounding: tail.grounding,
        suggestions: tail.suggestions,
      };
    }
    const trailingAnswer = this.buffer;
    this.emittedAnswer += this.buffer;
    this.buffer = "";
    return {
      trailingAnswer,
      fullAnswer: this.emittedAnswer,
      grounding: DEFAULT_GROUNDING,
      suggestions: [],
    };
  }
}
