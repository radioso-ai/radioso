import type { OpenAIChatUsage } from "./openAiTypes.js";

export interface NormalizedOpenAIUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptTokenDetails?: unknown;
  completionTokenDetails?: unknown;
}

export const normalizeOpenAIUsage = (
  usage: OpenAIChatUsage | undefined,
): NormalizedOpenAIUsage | undefined => {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    promptTokenDetails: usage.prompt_tokens_details,
    completionTokenDetails: usage.completion_tokens_details,
  };
};

export const withoutUndefined = (
  value: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
