import type { LlmProviderName } from "./providerTypes.js";

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
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5-mini", "gpt-5.4-nano", "gpt-5-nano"],
  "openai-compatible": [],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
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
