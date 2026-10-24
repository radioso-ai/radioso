import { createOpenAIClient } from "./openaiProvider.js";
import {
  type LlmCapabilityConfig,
  platformOpenAIEndpointFields,
  type PlatformOpenAIEndpoint,
} from "./providerTypes.js";

/**
 * The chat-completion probe's output budget. Generous enough for a reasoning model's hidden
 * reasoning tokens to settle before the cap bites — the probe only cares whether the endpoint
 * accepts the model, never what it answers.
 */
const PROBE_CHAT_COMPLETION_MAX_OUTPUT_TOKENS = 200;

interface ResidencyProbeInput {
  apiKey: string;
  endpoint: PlatformOpenAIEndpoint;
  model: string;
}

const probeCapabilityConfig = (
  capability: LlmCapabilityConfig["capability"],
  input: ResidencyProbeInput,
): LlmCapabilityConfig => ({
  capability,
  provider: "openai",
  model: input.model,
  apiKey: input.apiKey,
  ...platformOpenAIEndpointFields(input.endpoint),
});

/**
 * The default way the startup residency probe (`backend/src/runtime/openAIResidencyStartupCheck.ts`)
 * reaches OpenAI (or Azure OpenAI) for an embedding model: one embeddings call built through the
 * same pinned client factory every other native `openai` call uses, so the probe reaches the
 * exact host a real embedding call would. Lives here, not in `src/runtime/`, because
 * vendor-specific client modules (`openaiProvider.ts`) are importable only from within this
 * directory (`no-llm-vendor-providers-outside-llm-infra`).
 */
export const callOpenAIResidencyProbeEmbeddings = (input: ResidencyProbeInput): Promise<unknown> => {
  const client = createOpenAIClient(probeCapabilityConfig("embeddings", input));
  return client.embeddings.create({ model: input.model, input: "x" });
};

/**
 * The default way the startup residency probe reaches OpenAI (or Azure OpenAI) for a chat or
 * rerank model: a minimal chat completion through the same pinned client factory. Reasoning
 * models (the gpt-5 family) spend part of the output budget on hidden reasoning, so the probe
 * asks for enough completion tokens to let that settle — it only cares whether the call is
 * accepted, never what it answers.
 */
export const callOpenAIResidencyProbeChatCompletion = (input: ResidencyProbeInput): Promise<unknown> => {
  const client = createOpenAIClient(probeCapabilityConfig("chat", input));
  return client.chat.completions.create({
    model: input.model,
    messages: [{ role: "user", content: "x" }],
    max_completion_tokens: PROBE_CHAT_COMPLETION_MAX_OUTPUT_TOKENS,
  });
};
