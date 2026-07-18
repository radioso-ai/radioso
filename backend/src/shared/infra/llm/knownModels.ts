import type { LlmProviderName, ReasoningEffort } from "./providerTypes.js";

/**
 * Single source of truth for the (provider, model) pairs Radioso supports for
 * chat / rewrite / rerank capabilities. Update this when adding support for a
 * newer model. The backend validates workspace and per-agent overrides against
 * this catalog; the frontend renders a dropdown from the same list.
 *
 * `openai-compatible` is intentionally left empty — those endpoints can serve
 * arbitrary model IDs (vLLM, Ollama, LMStudio, etc.), so the upstream label is
 * accepted free-form. Every other provider is closed-set.
 */
export const knownModelsByProvider: Record<LlmProviderName, readonly string[]> = {
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5-mini", "gpt-5.4-nano", "gpt-5-nano"],
  "openai-compatible": [],
  gemini: [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  claude: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ],
};

/**
 * @returns `true` when `model` is a supported identifier for `provider`,
 *   or when `provider` is openai-compatible (which uses free-form model IDs).
 */
export const isKnownModelForProvider = (provider: LlmProviderName, model: string): boolean => {
  if (provider === "openai-compatible") {
    return model.trim().length > 0;
  }
  return knownModelsByProvider[provider].includes(model);
};

const GPT_5_MODEL_PATTERN = /^gpt-5(?:(?:\.(\d+))|[.-]|$)/i;
const MODERN_GPT_5_MINOR = 4;

const gpt5Minor = (model: string): number | null | undefined => {
  const match = GPT_5_MODEL_PATTERN.exec(model.trim());
  if (!match) {
    return undefined;
  }
  return match[1] === undefined ? null : Number.parseInt(match[1], 10);
};

export const isOpenAIGpt5Model = (model: string): boolean => gpt5Minor(model) !== undefined;

/**
 * OpenAI uses two lowest-effort vocabularies across the known gpt-5 families:
 * gpt-5.4+ accepts `none` and rejects `minimal`; earlier gpt-5 models accept
 * `minimal` and reject `none`. Normalize the provider-neutral hint at the model
 * catalog boundary so callers can ask for "lowest effort" without falling back to
 * the provider default.
 */
export const normalizeOpenAIReasoningEffort = (
  model: string,
  effort: ReasoningEffort,
): ReasoningEffort => {
  const minor = gpt5Minor(model);
  if (minor === undefined) {
    return effort;
  }
  if (minor !== null && minor >= MODERN_GPT_5_MINOR) {
    return effort === "minimal" ? "none" : effort;
  }
  return effort === "none" ? "minimal" : effort;
};
