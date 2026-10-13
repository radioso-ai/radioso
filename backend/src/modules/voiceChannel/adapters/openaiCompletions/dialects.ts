import { isLocaleTag } from "../../../../shared/domain/locale.js";
import type { VoiceTransport } from "../../domain.js";

/** Where one value travels on a request: a header, or a path into the JSON body. */
type CompletionsFieldSource = { header: string } | { bodyPath: readonly string[] };

/**
 * What tells one vendor's chat-completions requests apart from another's. Data only: the wire is
 * the same OpenAI protocol for every dialect. Sources are tried in order; the first usable value
 * wins. A source must identify one call: a value that spans calls, such as a user id, would join
 * separate calls into one conversation.
 */
export interface CompletionsDialect {
  id: string;
  sessionKeyFrom: readonly CompletionsFieldSource[];
  /** Where the caller's language tag travels, when the runtime or the page that starts the session sends one. */
  localeFrom: readonly CompletionsFieldSource[];
  transportDefault: VoiceTransport;
  /**
   * A delta sent after each bridge line and speech piece, for a runtime that speaks a sentence only
   * once a following non-blank delta arrives. Wire-only: never part of the stored reply.
   */
  sentenceFlushDelta?: string;
}

const COMPLETIONS_DIALECTS = new Map<string, CompletionsDialect>([
  // ElevenLabs sends no id of its own; the page that starts the session mints one and passes it as
  // the custom LLM extra body, which arrives on every turn under `elevenlabs_extra_body`.
  ["elevenlabs", {
    id: "elevenlabs",
    sessionKeyFrom: [{ bodyPath: ["elevenlabs_extra_body", "session_key"] }],
    localeFrom: [{ bodyPath: ["elevenlabs_extra_body", "locale"] }],
    transportDefault: "web",
    // Observed 2026-10-13: ElevenLabs holds a sentence back from speech until another non-blank
    // delta arrives. A space or a newline does not release it; a zero-width space does.
    sentenceFlushDelta: "\u200B",
  }],
  ["generic", {
    id: "generic",
    sessionKeyFrom: [{ header: "x-radioso-voice-session" }, { bodyPath: ["metadata", "session_key"] }],
    localeFrom: [{ header: "x-radioso-voice-locale" }, { bodyPath: ["metadata", "locale"] }],
    transportDefault: "web",
  }],
]);

export const findCompletionsDialect = (id: string): CompletionsDialect | null => COMPLETIONS_DIALECTS.get(id) ?? null;

interface CompletionsRequestParts {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBodyPath = (body: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, segment) => (isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined), body);

const readSource = (source: CompletionsFieldSource, request: CompletionsRequestParts): unknown => {
  if ("header" in source) {
    const value = request.headers[source.header.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
  return readBodyPath(request.body, source.bodyPath);
};

/**
 * A whole-value `{{…}}` is a template variable the vendor never filled in. It is the same text on
 * every call, so taking it as a key would merge every call into one conversation.
 */
const UNINTERPOLATED_PLACEHOLDER = /^\{\{.*\}\}$/u;

const usableValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && !UNINTERPOLATED_PLACEHOLDER.test(trimmed) ? trimmed : undefined;
};

/** The first source whose value is usable and passes `accept`; a source that fails falls through to the next. */
const firstValue = (
  sources: readonly CompletionsFieldSource[],
  request: CompletionsRequestParts,
  accept: (value: string) => boolean = () => true,
): string | undefined => {
  for (const source of sources) {
    const value = usableValue(readSource(source, request));
    if (value && accept(value)) {
      return value;
    }
  }
  return undefined;
};

export const sessionKeyFor = (dialect: CompletionsDialect, request: CompletionsRequestParts): string | null =>
  firstValue(dialect.sessionKeyFrom, request) ?? null;

/** The caller's language tag from the first source that carries a well-formed one. */
export const localeFor = (dialect: CompletionsDialect, request: CompletionsRequestParts): string | undefined =>
  firstValue(dialect.localeFrom, request, isLocaleTag);
