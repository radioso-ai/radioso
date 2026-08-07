import type { ReasoningEffort } from "./providerTypes.js";

/**
 * Which sampling params a chat model accepts is not derivable from its name.
 * Reasoning-effort vocabulary shifts between model versions (gpt-5-nano accepts
 * "minimal", gpt-5.4-nano rejects it), reasoning models reject any non-default
 * temperature, and `openai-compatible` endpoints serve arbitrary models behind
 * arbitrary ids. Guessing from the id would be wrong for all three, and would put
 * model knowledge in generic code.
 *
 * So support is *learned* rather than assumed: the API's own rejection is the
 * source of truth. This module detects each rejection and remembers it, so both
 * the chat.completions path (flat `reasoning_effort`, `temperature`) and the
 * Responses API rerank path (nested `reasoning.effort`) can strip-and-retry the
 * same way without importing each other's vendor module. Callers pay at most one
 * failed round-trip per endpoint/model/key support scope before the param is
 * dropped up front.
 *
 * Stripping is always the right degradation here: reasoning effort is only a
 * latency hint, and a model that rejects a temperature accepts nothing but its
 * own default — so dropping the param is the only way the call can succeed.
 */

/**
 * Keyed by support scope AND effort: a model that rejects "minimal" may still
 * accept "low", so rejecting one value must not strip a different (supported)
 * value on a later call to the same endpoint. A model that rejects the parameter
 * entirely simply gets each distinct effort cached on first use.
 */
const unsupportedByModelEffort = new Set<string>();

const cacheKey = (supportScope: string, effort: ReasoningEffort): string => JSON.stringify([supportScope, effort]);

export const isReasoningEffortKnownUnsupported = (supportScope: string, effort: ReasoningEffort): boolean =>
  unsupportedByModelEffort.has(cacheKey(supportScope, effort));

export const markReasoningEffortUnsupported = (supportScope: string, effort: ReasoningEffort): void => {
  unsupportedByModelEffort.add(cacheKey(supportScope, effort));
};

/**
 * True when an OpenAI error indicates the requested reasoning effort is not
 * supported. Matches both API shapes: chat.completions reports `param`
 * `"reasoning_effort"`, the Responses API reports `param` `"reasoning"` /
 * `"reasoning.effort"`. Falls back to an unsupported-* code that mentions
 * reasoning, to stay robust to wording changes.
 */
export const isUnsupportedReasoningEffortError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; param?: unknown; message?: unknown };
  const param = typeof candidate.param === "string" ? candidate.param : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const mentionsReasoning = `${param} ${message}`.toLowerCase().includes("reasoning");
  const unsupportedCode =
    code === "unsupported_value" || code === "unsupported_parameter" || code === "unknown_parameter";
  return param.startsWith("reasoning") || (unsupportedCode && mentionsReasoning);
};

/**
 * Keyed by support scope ONLY, unlike reasoning effort. A model that rejects a
 * temperature rejects every non-default value ("Only the default (1) value is
 * supported"), so one rejection is conclusive for that endpoint and remembering
 * per value would just buy a wasted round-trip per distinct temperature.
 */
const unsupportedTemperatureModels = new Set<string>();

export const isTemperatureKnownUnsupported = (supportScope: string): boolean =>
  unsupportedTemperatureModels.has(supportScope);

export const markTemperatureUnsupported = (supportScope: string): void => {
  unsupportedTemperatureModels.add(supportScope);
};

/**
 * True when an OpenAI error indicates the requested temperature is not supported.
 * Reads the structured fields — `param` `"temperature"` alongside an unsupported-*
 * code — and only falls back to the message as a robustness hedge against wording
 * changes, never as the sole signal. An out-of-range or otherwise invalid
 * temperature reports a different code and is left to surface as the caller bug it
 * is.
 */
export const isUnsupportedTemperatureError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; param?: unknown; message?: unknown };
  const param = typeof candidate.param === "string" ? candidate.param : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const mentionsTemperature = `${param} ${message}`.toLowerCase().includes("temperature");
  const unsupportedCode =
    code === "unsupported_value" || code === "unsupported_parameter" || code === "unknown_parameter";
  return unsupportedCode && (param === "temperature" || mentionsTemperature);
};
