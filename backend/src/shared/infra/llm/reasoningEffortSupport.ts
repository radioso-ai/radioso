import type { ReasoningEffort } from "./providerTypes.js";

/**
 * Reasoning-effort support varies across OpenAI reasoning models and versions:
 * some (e.g. gpt-5-nano) accept "minimal" while others (e.g. gpt-5.4-nano) reject
 * that value with a 400 unsupported_value. The effort is only a latency hint, so
 * a rejection must never break the call - callers strip it and retry. This module
 * is the shared home for detecting that rejection and remembering it, so both the
 * chat.completions path (flat `reasoning_effort`) and the Responses API rerank
 * path (nested `reasoning.effort`) degrade the same way without importing each
 * other's vendor module.
 *
 * The cache is keyed by model AND effort: a model that rejects "minimal" may still
 * accept "low", so rejecting one value must not strip a different (supported) value
 * on a later call to the same model. A model that rejects the parameter entirely
 * simply gets each distinct effort cached on first use - at most one failed
 * round-trip per (model, effort).
 */
const unsupportedByModelEffort = new Set<string>();

const cacheKey = (model: string, effort: ReasoningEffort): string => JSON.stringify([model, effort]);

export const isReasoningEffortKnownUnsupported = (model: string, effort: ReasoningEffort): boolean =>
  unsupportedByModelEffort.has(cacheKey(model, effort));

export const markReasoningEffortUnsupported = (model: string, effort: ReasoningEffort): void => {
  unsupportedByModelEffort.add(cacheKey(model, effort));
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
