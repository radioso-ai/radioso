import type { ChatSuggestionKind } from "../types/chatResponses.js";
import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import type { AnswerSchemaExtension } from "../../../shared/domain/answerSideChannel.js";
import { StructuredAnswerFieldReader } from "./structuredAnswerFieldReader.js";

export const SUGGESTIONS_SENTINEL = "<<<RADIOSO_FOLLOWUPS_JSON>>>";

export type GroundingEnvelopeParseStatus =
  | "valid_v2"
  | "legacy_v1"
  | "missing"
  | "malformed"
  | "invalid_v2";

/**
 * `no_support` and `out_of_scope` are both final declines and obey the same body
 * rules; they differ only in why the turn declined. The envelope transports the
 * distinction, {@link ./groundingAssertions.js} interprets it.
 */
export type GroundingEnvelopeOutcome = "answer" | "no_support" | "out_of_scope";

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
  /**
   * Opaque structured fields the model returned that the envelope itself does not
   * interpret — populated only from schema extensions a caller merged in via
   * {@link buildGroundedAnswerResponseFormat}. The envelope transports them; the
   * caller (e.g. a directive-adherence probe) owns their meaning.
   */
  extras?: Record<string, unknown>;
}

/** Top-level envelope keys the envelope interprets itself; anything else is an extra. */
const CORE_ENVELOPE_KEYS = new Set(["answer", "v", "outcome", "claims", "suggestions", "grounding"]);

const GROUNDED_ANSWER_RESPONSE_FORMAT_BASE: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "grounded_answer_envelope",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "v", "outcome", "claims", "suggestions", "grounding"],
    properties: {
      answer: {
        type: "string",
        description: "Visible markdown answer only. Never include a follow-up-question heading, menu, or list here.",
      },
      v: { type: "integer", enum: [2] },
      outcome: { type: "string", enum: ["answer", "no_support", "out_of_scope"] },
      claims: {
        type: "array",
        items: {
          type: "array",
          items: { type: "integer", minimum: 1 },
        },
      },
      suggestions: {
        type: "array",
        description: "Follow-up questions belong only in this array, never in answer.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "kind", "contextIndex"],
          properties: {
            text: { type: "string" },
            kind: { type: "string", enum: ["deeper", "broader"] },
            contextIndex: { type: "integer", minimum: 1 },
          },
        },
      },
      grounding: { type: "string", enum: ["degraded"] },
    },
  },
};

/**
 * Builds the strict grounded-envelope schema, optionally merging a caller-supplied
 * structured extension (extra `properties` + `required`). The envelope stays
 * capability-neutral: it does not know what the extension means, only how to carry
 * it. Callers that have nothing to add pass no extension and get the base schema.
 */
export const buildGroundedAnswerResponseFormat = (
  extension?: AnswerSchemaExtension | null,
): JsonSchemaResponseFormat => {
  const baseProperties = GROUNDED_ANSWER_RESPONSE_FORMAT_BASE.schema.properties as Record<string, unknown>;
  const baseRequired = GROUNDED_ANSWER_RESPONSE_FORMAT_BASE.schema.required as string[];
  if (!extension) {
    return GROUNDED_ANSWER_RESPONSE_FORMAT_BASE;
  }
  return {
    ...GROUNDED_ANSWER_RESPONSE_FORMAT_BASE,
    schema: {
      ...GROUNDED_ANSWER_RESPONSE_FORMAT_BASE.schema,
      properties: { ...baseProperties, ...extension.properties },
      required: [...baseRequired, ...extension.required],
    },
  };
};

/** Base schema for callers with no structured extension to contribute. */
export const GROUNDED_ANSWER_RESPONSE_FORMAT = buildGroundedAnswerResponseFormat();

type ParsedEnvelopeTail = Omit<GroundedAnswerEnvelope, "answer">;

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

/** Collect any model-returned top-level fields the envelope does not interpret itself. */
const collectExtras = (record: Record<string, unknown>): Record<string, unknown> | undefined => {
  const entries = Object.entries(record).filter(([key]) => !CORE_ENVELOPE_KEYS.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const parseEnvelopeValue = (parsed: unknown): ParsedEnvelopeTail => {
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
  const outcome = record.outcome === "answer"
    || record.outcome === "no_support"
    || record.outcome === "out_of_scope"
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

  const extras = collectExtras(record);
  return {
    protocolVersion: 2,
    parseStatus: "valid_v2",
    outcome,
    claims,
    suggestions: readSuggestionsArray(record.suggestions),
    ...(extras ? { extras } : {}),
  };
};

const parseEnvelopeTail = (buffer: string): ParsedEnvelopeTail => {
  const trimmed = buffer.trim();
  if (!trimmed) {
    return emptyTail("malformed");
  }

  try {
    return parseEnvelopeValue(JSON.parse(trimmed));
  } catch {
    return emptyTail("malformed");
  }
};

const parseStructuredEnvelope = (raw: string): GroundedAnswerEnvelope | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.answer !== "string") {
    return null;
  }
  return {
    answer: record.answer.trim(),
    ...parseEnvelopeValue(record),
  };
};

export const parseGroundedAnswerEnvelope = (raw: string): GroundedAnswerEnvelope => {
  const structured = parseStructuredEnvelope(raw);
  if (structured) {
    return structured;
  }
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
  private mode: "undecided" | "structured" | "legacy" = "undecided";
  private undecidedBuffer = "";
  private readonly structuredReader = new StructuredAnswerFieldReader();
  private buffer = "";
  private tailChunks: string[] = [];
  private inTail = false;
  private emittedAnswer = "";

  push(chunk: string): string {
    if (!chunk) {
      return "";
    }
    if (this.mode === "undecided") {
      this.undecidedBuffer += chunk;
      const first = this.undecidedBuffer.match(/\S/)?.[0];
      if (!first) {
        return "";
      }
      this.mode = first === "{" ? "structured" : "legacy";
      const initial = this.undecidedBuffer;
      this.undecidedBuffer = "";
      return this.mode === "structured"
        ? this.structuredReader.push(initial)
        : this.pushLegacy(initial);
    }
    if (this.mode === "structured") {
      return this.structuredReader.push(chunk);
    }
    return this.pushLegacy(chunk);
  }

  private pushLegacy(chunk: string): string {
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
    if (this.mode === "undecided" && this.undecidedBuffer) {
      const initial = this.undecidedBuffer;
      this.undecidedBuffer = "";
      this.push(initial);
    }
    if (this.mode === "structured") {
      const parsed = parseStructuredEnvelope(this.structuredReader.raw);
      if (!parsed) {
        return {
          trailingAnswer: "",
          fullAnswer: this.structuredReader.answer,
          ...emptyTail("malformed"),
        };
      }
      const trailingAnswer = parsed.answer.slice(this.structuredReader.answer.length);
      return {
        trailingAnswer,
        fullAnswer: parsed.answer,
        protocolVersion: parsed.protocolVersion,
        parseStatus: parsed.parseStatus,
        outcome: parsed.outcome,
        claims: parsed.claims,
        suggestions: parsed.suggestions,
        ...(parsed.extras !== undefined ? { extras: parsed.extras } : {}),
      };
    }
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
