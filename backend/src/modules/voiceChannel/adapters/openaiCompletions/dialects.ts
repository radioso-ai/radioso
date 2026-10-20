import { isLocaleTag } from "../../../../shared/domain/locale.js";
import type { VoiceLanguageSwitchOffer, VoiceLanguageSwitchResult, VoiceTransport } from "../../domain.js";
import {
  offersLanguageSwitch,
  readLanguageSwitch,
  refusedSwitchLanguages,
  switchFollowUpOf,
  type LanguageSwitchTool,
  type TurnLanguageReading,
} from "./languageSwitches.js";
import type { CompletionsMessage } from "./requestSchema.js";

/** Where one value travels on a request: a header, or a path into the JSON body. */
type CompletionsFieldSource = { header: string } | { bodyPath: readonly string[] };

/**
 * Where the language of one turn travels: the runtime's replayed calls of a tool that switches the
 * call's language (reported as `vendor_detected`), or a field it sets per turn (`turn_field`).
 */
type CompletionsTurnLocaleSource = { languageSwitch: LanguageSwitchTool } | { field: CompletionsFieldSource };

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
    // Observed 2026-10-18 (live probe, an agent with the tool and an `it` preset): every request
    // offers it in `tools`. A reply that is only the call (`finish_reason: "tool_calls"`, no
    // content: content beside it is spoken twice) is run, and about 550 ms later the vendor asks
    // again with the call replayed under its id prefixed `fc_`, then its result as the newest
    // message: JSON `{"result_type":"language_detection_success","status":"success",…}`, or plain
    // text for a language outside the presets ("Invalid language. Keep speaking English."). What
    // that follow-up streams is what the caller hears; the user message is not asked again.
    turnLocaleFrom: [{
      languageSwitch: {
        tool: "language_detection",
        argument: "language",
        reasonArgument: "reason",
        replayedCallIdPrefix: "fc_",
        result: { field: "status", success: "success", errorFlag: "is_error" },
      },
    }],
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

/**
 * The language this one turn reports apart from the session's. A per-turn field is the first that
 * carries a language tag, and always this turn's news. A language switch is the newest in the
 * history that took effect; one that cannot be read stops the search and is reported, since the
 * call may then be in either language.
 */
export const turnLanguageFor = (
  dialect: CompletionsDialect,
  request: CompletionsRequestParts & { messages: readonly CompletionsMessage[] },
): TurnLanguageReading => {
  for (const source of dialect.turnLocaleFrom) {
    if ("languageSwitch" in source) {
      const reading = readLanguageSwitch(request.messages, source.languageSwitch);
      if (reading.turnLanguage || reading.languageReport) {
        return reading;
      }
      continue;
    }
    const tag = firstValue([source.field], request, isLocaleTag);
    if (tag) {
      return { turnLanguage: { tag, source: "turn_field", isNew: true } };
    }
  }
  return {};
};

/** The dialect's tool that switches the call's language, when its runtime has one. */
const languageSwitchToolOf = (dialect: CompletionsDialect): LanguageSwitchTool | undefined => {
  for (const source of dialect.turnLocaleFrom) {
    if ("languageSwitch" in source) {
      return source.languageSwitch;
    }
  }
  return undefined;
};

/** How a reply calls the dialect's switching tool, when its runtime has one. */
export const languageSwitchRenderingFor = (dialect: CompletionsDialect): Pick<LanguageSwitchTool, "tool" | "argument" | "reasonArgument"> | undefined => {
  const tool = languageSwitchToolOf(dialect);
  return tool ? { tool: tool.tool, argument: tool.argument, reasonArgument: tool.reasonArgument } : undefined;
};

/**
 * The runtime's offer to switch the call's language on this request: its `tools` carry the
 * dialect's switching tool. With the languages it refused earlier in the call.
 */
export const languageSwitchOfferFor = (
  dialect: CompletionsDialect,
  request: { tools?: readonly unknown[] | null; messages: readonly CompletionsMessage[] },
): VoiceLanguageSwitchOffer | undefined => {
  const tool = languageSwitchToolOf(dialect);
  return tool && offersLanguageSwitch(request.tools, tool) ? { refused: refusedSwitchLanguages(request.messages, tool) } : undefined;
};

/** The request is the runtime's follow-up after a switch a reply asked for: which, and whether it switched. */
export const languageSwitchResultFor = (
  dialect: CompletionsDialect,
  request: { messages: readonly CompletionsMessage[] },
): VoiceLanguageSwitchResult | null => {
  const tool = languageSwitchToolOf(dialect);
  const followUp = tool ? switchFollowUpOf(request.messages, tool) : null;
  return followUp ? { switchId: followUp.callId, confirmed: followUp.confirmed } : null;
};
