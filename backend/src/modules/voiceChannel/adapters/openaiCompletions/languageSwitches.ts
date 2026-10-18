import { isLocaleTag } from "../../../../shared/domain/locale.js";
import type { VoiceTurnInput } from "../../domain.js";

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
   * How the tool's result says whether the switch took effect: a JSON object whose `field` holds
   * `success` when it did and anything else when the runtime refused it, or whose `errorFlag` is true.
   */
  result: { field: string; success: string; errorFlag: string };
}

/** What a request's history says about the call's language. */
export type LanguageSwitchReading = Pick<VoiceTurnInput, "turnLanguage" | "turnLanguageIsNew" | "languageReport">;

type SwitchOutcome = { tag: string } | "blocked" | "unreadable";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON object sent as a string, or an object as it is. */
const objectOf = (value: unknown): Record<string, unknown> | undefined => {
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

/** A message's text: a string, or its `text` content parts joined. */
const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");
};

const tagOf = (value: unknown): string | undefined => {
  const tag = typeof value === "string" ? value.trim() : "";
  return isLocaleTag(tag) ? tag : undefined;
};

/** The calls of the tool in one replayed message, oldest first; none for a message that is not the assistant's. */
const callsIn = (message: unknown, tool: string): Array<Record<string, unknown> & { function: Record<string, unknown> }> =>
  isRecord(message) && message.role === "assistant" && Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((call): call is Record<string, unknown> & { function: Record<string, unknown> } =>
      isRecord(call) && isRecord(call.function) && call.function.name === tool)
    : [];

/** The result the runtime replays for one call: the `tool` message after it with the call's id. */
const resultOf = (messages: readonly unknown[], after: number, callId: unknown): Record<string, unknown> | undefined => {
  if (typeof callId !== "string" || callId.length === 0) {
    return undefined;
  }
  const result = messages.slice(after + 1).find((message) => isRecord(message) && message.role === "tool" && message.tool_call_id === callId);
  return isRecord(result) ? objectOf(textOf(result.content)) : undefined;
};

/** Whether one call switched the call's language: to which tag, refused, or not to be read. */
const outcomeOf = (
  call: { id?: unknown; function: Record<string, unknown> },
  messages: readonly unknown[],
  index: number,
  switchTool: LanguageSwitchTool,
): SwitchOutcome => {
  const tag = tagOf(objectOf(call.function.arguments)?.[switchTool.argument]);
  const result = resultOf(messages, index, call.id);
  if (!tag || !result) {
    return "unreadable";
  }
  const { field, success, errorFlag } = switchTool.result;
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
 * leaves the language as the one before it had it; a switch that cannot be read (its arguments, or
 * its result, missing or of an unknown shape) ends the search, because the call may be in either
 * language. A switch after the caller's previous utterance is news on this request.
 */
export const readLanguageSwitch = (body: unknown, switchTool: LanguageSwitchTool): LanguageSwitchReading => {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages as unknown[] : [];
  const userIndexes = messages.flatMap((message, index) => (isRecord(message) && message.role === "user" ? [index] : []));
  const previousUtterance = userIndexes.at(-2) ?? -1;
  let newestRefused = false;
  let first = true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const call of callsIn(messages[index], switchTool.tool).reverse()) {
      const outcome = outcomeOf(call, messages, index, switchTool);
      const report = newestRefused ? { languageReport: "blocked" as const } : {};
      if (outcome === "unreadable") {
        return first ? { languageReport: "unreadable" } : report;
      }
      if (outcome !== "blocked") {
        return { turnLanguage: { tag: outcome.tag, source: "vendor_detected" }, turnLanguageIsNew: index > previousUtterance, ...report };
      }
      newestRefused ||= first;
      first = false;
    }
  }
  return newestRefused ? { languageReport: "blocked" } : {};
};
