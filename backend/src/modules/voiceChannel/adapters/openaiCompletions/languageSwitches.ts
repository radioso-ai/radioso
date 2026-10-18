import { isLocaleTag } from "../../../../shared/domain/locale.js";
import type { VoiceLanguageReportProblem, VoiceReportedTurnLanguage } from "../../domain.js";
import { textOf, type CompletionsMessage } from "./requestSchema.js";

/**
 * A runtime tool that switches the call's language, as the runtime replays its calls in the
 * request's history: an assistant message's OpenAI `tool_calls`, each answered by a `tool` message
 * with the same `tool_call_id`. Data, named by the dialect.
 */
export interface LanguageSwitchTool {
  /** The tool's name in `function.name`. */
  tool: string;
  /** The argument of `function.arguments` that names the language. */
  argument: string;
  /**
   * How a result object says whether the switch took effect: its `field` holds `success` when it
   * did and anything else when the runtime refused it, or its `errorFlag` is true.
   */
  result: { field: string; success: string; errorFlag: string };
}

/** What a request reports about its turn's language, as the wire carries it. */
export interface TurnLanguageReading {
  turnLanguage?: VoiceReportedTurnLanguage;
  turnLanguageIsNew?: boolean;
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

const tagOf = (value: unknown): string | undefined => {
  const tag = typeof value === "string" ? value.trim() : "";
  return isLocaleTag(tag) ? tag : undefined;
};

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
  const tag = tagOf(objectOf(call.function.arguments)?.[switchTool.argument]);
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
      return {
        turnLanguage: { tag: outcome.tag, source: "vendor_detected" },
        turnLanguageIsNew: index > previousUtterance,
        ...(refused ? { languageReport: "blocked" as const } : {}),
      };
    }
  }
  return refused ? { languageReport: "blocked" } : {};
};
