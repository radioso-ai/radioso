import { localeTagOf } from "../../../../shared/domain/locale.js";
import { VOICE_LANGUAGE_SWITCH_REASONS, type VoiceLanguageReportProblem, type VoiceReportedTurnLanguage } from "../../domain.js";
import { textOf, type CompletionsMessage } from "./requestSchema.js";

/**
 * A runtime tool that switches the call's language, as the runtime replays its calls in the
 * request's history: an assistant message's OpenAI `tool_calls`, each answered by a `tool` message
 * with the same `tool_call_id`. Data, named by the dialect.
 */
export interface LanguageSwitchTool {
  /** The tool's name in `function.name`, in the request's `tools` and in the calls it replays. */
  tool: string;
  /** The argument of `function.arguments` that names the language. */
  argument: string;
  /** The argument of `function.arguments` that says why, which a call Radioso makes fills. */
  reasonArgument: string;
  /** What the runtime puts before the id of a call Radioso made when it replays the call. */
  replayedCallIdPrefix?: string;
  /**
   * How a result object says whether the switch took effect: its `field` holds `success` when it
   * did and anything else when the runtime refused it, or its `errorFlag` is true.
   */
  result: { field: string; success: string; errorFlag: string };
}

/** What a request reports about its turn's language, as the wire carries it. */
export interface TurnLanguageReading {
  turnLanguage?: VoiceReportedTurnLanguage;
  languageReport?: VoiceLanguageReportProblem;
}

type SwitchOutcome = { tag: string } | "blocked" | "unreadable";

type ToolCall = Record<string, unknown> & { function: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON object sent as a string, or an object as it is; undefined for anything else. */
const objectOf = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value) || typeof value !== "string") {
    return isRecord(value) ? value : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** Text that is meant as JSON: an object or an array, by its first character. */
const looksLikeJson = (text: string): boolean => text.startsWith("{") || text.startsWith("[");

/** The calls of the tool in one replayed message, oldest first; none for a message that is not the assistant's. */
const callsIn = (message: CompletionsMessage, tool: string): ToolCall[] =>
  message.role === "assistant" && Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((call): call is ToolCall => isRecord(call) && isRecord(call.function) && call.function.name === tool)
    : [];

const callsId = (message: CompletionsMessage, callId: string): boolean =>
  message.role === "assistant" && Array.isArray(message.tool_calls)
  && message.tool_calls.some((call) => isRecord(call) && call.id === callId);

/**
 * The result the runtime replays for one call: the nearest `tool` message after it with the call's
 * id, before any later call that reuses the id. Its text, or undefined when there is none.
 */
const resultTextOf = (messages: readonly CompletionsMessage[], after: number, callId: unknown): string | undefined => {
  if (typeof callId !== "string" || callId.length === 0) {
    return undefined;
  }
  for (const message of messages.slice(after + 1)) {
    if (message.role === "tool" && message.tool_call_id === callId) {
      const text = textOf(message.content).trim();
      return text.length > 0 ? text : undefined;
    }
    if (callsId(message, callId)) {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Whether one call switched the call's language: to which tag, refused, or not to be read. The
 * runtime answers a refused switch with an error for the LLM, as text, so a result that is not
 * JSON is a refusal; a result object reads by its fields.
 */
const outcomeOf = (call: ToolCall, messages: readonly CompletionsMessage[], index: number, switchTool: LanguageSwitchTool): SwitchOutcome => {
  const tag = localeTagOf(objectOf(call.function.arguments)?.[switchTool.argument]);
  const text = resultTextOf(messages, index, call.id);
  if (!tag || text === undefined) {
    return "unreadable";
  }
  if (!looksLikeJson(text)) {
    return "blocked";
  }
  const result = objectOf(text);
  const { field, success, errorFlag } = switchTool.result;
  if (!result) {
    return "unreadable";
  }
  if (result[errorFlag] === true) {
    return "blocked";
  }
  if (typeof result[field] !== "string") {
    return "unreadable";
  }
  return result[field] === success ? { tag } : "blocked";
};

/** Whether a call is one Radioso made: its reason argument is one Radioso writes. */
const askedByRadioso = (call: ToolCall, switchTool: LanguageSwitchTool): boolean => {
  const reason = objectOf(call.function.arguments)?.[switchTool.reasonArgument];
  return typeof reason === "string" && (VOICE_LANGUAGE_SWITCH_REASONS as readonly string[]).includes(reason);
};

/**
 * The call's language by the newest switch the history carries that took effect. A refused switch
 * leaves the language as the one before it had it, so the search goes on past it; a switch that
 * cannot be read (its arguments, or its result, missing or of an unknown shape) ends it with the
 * language unknown, because the call may be in either. A switch after the caller's previous
 * utterance is news on this request.
 */
export const readLanguageSwitch = (messages: readonly CompletionsMessage[], switchTool: LanguageSwitchTool): TurnLanguageReading => {
  const userIndexes = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  const previousUtterance = userIndexes.at(-2) ?? -1;
  let refused = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    for (const call of message ? callsIn(message, switchTool.tool).reverse() : []) {
      const outcome = outcomeOf(call, messages, index, switchTool);
      if (outcome === "unreadable") {
        return { languageReport: "unreadable" };
      }
      if (outcome === "blocked") {
        refused = true;
        continue;
      }
      // A switch Radioso asked for is no news to chat: the turn that asked answered in it already.
      return {
        turnLanguage: { tag: outcome.tag, source: "vendor_detected", isNew: index > previousUtterance && !askedByRadioso(call, switchTool) },
        ...(refused ? { languageReport: "blocked" as const } : {}),
      };
    }
  }
  return refused ? { languageReport: "blocked" } : {};
};

/** Whether the request's `tools` offer the tool, so a reply may call it. */
export const offersLanguageSwitch = (tools: readonly unknown[] | null | undefined, switchTool: Pick<LanguageSwitchTool, "tool">): boolean =>
  (tools ?? []).some((tool) => isRecord(tool) && isRecord(tool.function) && tool.function.name === switchTool.tool);

/** The languages the runtime refused to switch the call to, as their calls named them, oldest first and once each. */
export const refusedSwitchLanguages = (messages: readonly CompletionsMessage[], switchTool: LanguageSwitchTool): string[] => {
  const refused = new Set<string>();
  messages.forEach((message, index) => {
    for (const call of callsIn(message, switchTool.tool)) {
      const tag = localeTagOf(objectOf(call.function.arguments)?.[switchTool.argument]);
      if (tag && outcomeOf(call, messages, index, switchTool) === "blocked") {
        refused.add(tag);
      }
    }
  });
  return [...refused];
};

/**
 * The runtime's follow-up request after running a call of the tool that Radioso made: its newest
 * message is that call's result. The call's id as Radioso named it (the runtime's replay prefix
 * removed) and whether the call switched the call's language; a result refused or unreadable
 * switched nothing. Null when the newest message is no result of such a call.
 */
export const switchFollowUpOf = (
  messages: readonly CompletionsMessage[],
  switchTool: LanguageSwitchTool,
): { callId: string; confirmed: boolean } | null => {
  const newest = messages.at(-1);
  const replayedId = newest?.role === "tool" ? newest.tool_call_id : undefined;
  if (typeof replayedId !== "string" || replayedId.length === 0) {
    return null;
  }
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    const call = message ? callsIn(message, switchTool.tool).find((candidate) => candidate.id === replayedId) : undefined;
    if (call) {
      if (!askedByRadioso(call, switchTool)) {
        return null;
      }
      const prefix = switchTool.replayedCallIdPrefix;
      const callId = prefix && replayedId.startsWith(prefix) ? replayedId.slice(prefix.length) : replayedId;
      return { callId, confirmed: typeof outcomeOf(call, messages, index, switchTool) === "object" };
    }
    if (message && callsId(message, replayedId)) {
      // The result answers a call of another tool.
      return null;
    }
  }
  return null;
};
