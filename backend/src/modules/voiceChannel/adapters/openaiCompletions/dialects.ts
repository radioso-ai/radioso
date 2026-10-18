import { isLocaleTag } from "../../../../shared/domain/locale.js";
import type { VoiceReportedTurnLanguage, VoiceTransport } from "../../domain.js";

/** Where one value travels on a request: a header, or a path into the JSON body. */
type CompletionsFieldSource = { header: string } | { bodyPath: readonly string[] };

/**
 * A call of one of the runtime's own tools, as the request's replayed history carries it (the
 * OpenAI `tool_calls` of an assistant message): the named argument of the newest call of `tool`.
 */
interface CompletionsToolCallSource {
  toolCall: { tool: string; argument: string };
}

/**
 * Where the language of one turn travels: the runtime's record of switching the call's language
 * (a tool call it replays, reported as `vendor_detected`), or a field it sets per turn (`turn_field`).
 */
type CompletionsTurnLocaleSource = CompletionsToolCallSource | { field: CompletionsFieldSource };

/**
 * What tells one vendor's chat-completions requests apart from another's. Data only: the wire is
 * the same OpenAI protocol for every dialect. Sources are tried in order; the first usable value
 * wins. A source must identify one call: a value that spans calls, such as a user id, would join
 * separate calls into one conversation.
 */
export interface CompletionsDialect {
  id: string;
  sessionKeyFrom: readonly CompletionsFieldSource[];
  /** Where the session's language tag travels, when the runtime or the page that starts the session sends one. */
  localeFrom: readonly CompletionsFieldSource[];
  /** Where the language of this one turn travels, when the runtime reports it apart from the session's. */
  turnLocaleFrom: readonly CompletionsTurnLocaleSource[];
  transportDefault: VoiceTransport;
  /**
   * A delta sent after each bridge line and speech piece, for a runtime that holds a finished
   * sentence back from speech until the wire shows it ended. Wire-only: never part of the stored reply.
   */
  sentenceFlushDelta?: string;
  /**
   * For a runtime that holds a reply's first sentence back from speech until it has this many
   * characters: a shorter bridge line waits for the answer, so the turn prefers lines this long.
   */
  minReleasableSentenceChars?: number;
  /**
   * For a runtime that abandons a stream after a stretch of silence: once no frame has been written
   * for `afterIdleMs`, the route writes `delta` and keeps doing so while the turn stays silent.
   * Wire-only, like the flush delta.
   */
  keepAlive?: { delta: string; afterIdleMs: number };
  /**
   * For a runtime that replays the agent's reply cut short when the caller spoke over it: the
   * suffix it appends to the part that was heard. The reply right before the newest user message,
   * ending in it, is what the caller heard (`VoiceTurnInput.heardUntil`).
   */
  interruptedReplySuffix?: string;
}

/**
 * Observed 2026-10-13: ElevenLabs holds a reply's first sentence until it has about 45 characters
 * (26 waited for the next sentence; 46 and 57 did not). Any first sentence, so a bridge line and a
 * fallback line alike. Authoring guidance (the Voice card, Ray's descriptors) reads this number.
 */
export const ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS = 45;

const COMPLETIONS_DIALECTS = new Map<string, CompletionsDialect>([
  // ElevenLabs sends no id of its own; the page that starts the session mints one and passes it as
  // the custom LLM extra body, which arrives on every turn under `elevenlabs_extra_body`.
  ["elevenlabs", {
    id: "elevenlabs",
    sessionKeyFrom: [{ bodyPath: ["elevenlabs_extra_body", "session_key"] }],
    localeFrom: [{ bodyPath: ["elevenlabs_extra_body", "locale"] }],
    // The `language_detection` system tool switches the call's voice and transcription to the
    // language its `language` argument names (an ISO 639-1 code such as "it"), as an OpenAI tool
    // call: https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/language-detection
    // Each request replays the call's history, so the newest such call is the call's language now.
    turnLocaleFrom: [{ toolCall: { tool: "language_detection", argument: "language" } }],
    transportDefault: "web",
    // Observed 2026-10-13: ElevenLabs hands a sentence to speech once its terminator is followed by
    // whitespace and a later non-blank delta arrives. Pieces end on the terminator, so the flush is
    // a space (the whitespace) plus a zero-width space (the non-blank delta), sent as one chunk.
    sentenceFlushDelta: " \u200B",
    minReleasableSentenceChars: ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS,
    // Observed 2026-10-13: ElevenLabs drops a custom-LLM stream that is silent for about 4 s (4.0 s
    // held, 4.5 s dropped) and re-asks with the same utterance; any invisible delta resets that.
    keepAlive: { delta: " \u200B", afterIdleMs: 2_500 },
    // Observed 2026-10-12: after a barge-in, the next request's history carries the interrupted
    // reply truncated to what was heard, followed by "...".
    interruptedReplySuffix: "...",
  }],
  ["generic", {
    id: "generic",
    sessionKeyFrom: [{ header: "x-radioso-voice-session" }, { bodyPath: ["metadata", "session_key"] }],
    localeFrom: [{ header: "x-radioso-voice-locale" }, { bodyPath: ["metadata", "locale"] }],
    turnLocaleFrom: [{ field: { header: "x-radioso-voice-turn-locale" } }, { field: { bodyPath: ["metadata", "turn_locale"] } }],
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

/** The session's language tag from the first source that carries a well-formed one. */
export const localeFor = (dialect: CompletionsDialect, request: CompletionsRequestParts): string | undefined =>
  firstValue(dialect.localeFrom, request, isLocaleTag);

/** A tool call's arguments: OpenAI sends them as a JSON string; an object is taken as it is. */
const argumentsOf = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The OpenAI tool calls of one replayed message, in order; none for a message that is not the assistant's. */
const toolCallsOf = (message: unknown): readonly unknown[] =>
  isRecord(message) && message.role === "assistant" && Array.isArray(message.tool_calls) ? message.tool_calls : [];

const isCallOf = (tool: string) => (call: unknown): call is { function: Record<string, unknown> } =>
  isRecord(call) && isRecord(call.function) && call.function.name === tool;

/**
 * The named argument of the newest call of the tool in the replayed history. Only the newest call
 * counts: when it cannot be read, an older one would name a language the call has moved past.
 */
const readToolCallArgument = ({ toolCall }: CompletionsToolCallSource, body: unknown): unknown => {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages as unknown[] : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const newest = toolCallsOf(messages[index]).filter(isCallOf(toolCall.tool)).at(-1);
    if (newest) {
      const args = argumentsOf(newest.function.arguments);
      return args && Object.hasOwn(args, toolCall.argument) ? args[toolCall.argument] : undefined;
    }
  }
  return undefined;
};

/**
 * The language this one turn reports apart from the session's: the first source that carries a
 * well-formed tag, and whether the runtime's own language switch or a per-turn field named it.
 */
export const turnLanguageFor = (dialect: CompletionsDialect, request: CompletionsRequestParts): VoiceReportedTurnLanguage | undefined => {
  for (const source of dialect.turnLocaleFrom) {
    if ("toolCall" in source) {
      const tag = usableValue(readToolCallArgument(source, request.body));
      if (tag && isLocaleTag(tag)) {
        return { tag, source: "vendor_detected" };
      }
      continue;
    }
    const tag = firstValue([source.field], request, isLocaleTag);
    if (tag) {
      return { tag, source: "turn_field" };
    }
  }
  return undefined;
};
