import type OpenAI from "openai";

import { createOpenAIClient } from "./openaiProvider.js";
import { isOpenAIGpt5Model, normalizeOpenAIReasoningEffort } from "./knownModels.js";
import {
  type LlmCapabilityConfig,
  platformOpenAIEndpointFields,
  type PlatformOpenAIEndpoint,
} from "./providerTypes.js";

/**
 * The probe's output budget: generous enough for a reasoning model's hidden reasoning to settle
 * before the cap bites, small enough to keep probe cost and latency negligible. The probe only
 * cares whether the endpoint accepts the model, never what it answers.
 */
const PROBE_MAX_OUTPUT_TOKENS = 200;

/**
 * Startup must not wait out the OpenAI SDK's own retry/backoff (several requests over tens of
 * seconds) before classifying an endpoint as transiently failing. A short timeout plus no SDK
 * retries means one slow or 5xx-ing probe reaches the warn-and-continue path in roughly this many
 * milliseconds, not minutes — and with every probe running in parallel, total probe time stays
 * bounded by the slowest one, not their sum.
 */
const PROBE_TIMEOUT_MS = 10_000;

// The installed OpenAI SDK types predate "none" as a reasoning_effort value, though the API
// accepts it (see openaiProvider.ts's own toSdkSampling for the same coercion on a real call).
type OpenAIChatReasoningEffort = OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"];

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

const probeClient = (capability: LlmCapabilityConfig["capability"], input: ResidencyProbeInput) =>
  createOpenAIClient(probeCapabilityConfig(capability, input), {
    timeoutMs: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });

/**
 * The default way the startup residency probe (`backend/src/runtime/openAIResidencyStartupCheck.ts`)
 * reaches OpenAI (or Azure OpenAI) for an embedding model: one embeddings call built through the
 * same pinned client factory every other native `openai` call uses, so the probe reaches the
 * exact host a real embedding call would. Lives here, not in `src/runtime/`, because
 * vendor-specific client modules (`openaiProvider.ts`) are importable only from within this
 * directory (`no-llm-vendor-providers-outside-llm-infra`).
 */
export const callOpenAIResidencyProbeEmbeddings = (input: ResidencyProbeInput): Promise<unknown> =>
  probeClient("embeddings", input).embeddings.create({ model: input.model, input: "x" });

/**
 * The default way the startup residency probe reaches OpenAI (or Azure OpenAI) for a chat or
 * rewrite model: a minimal chat completion through the same pinned client factory. Reasoning
 * models (the gpt-5 family) spend part of the output budget on hidden reasoning by default, so
 * the probe asks for the lowest effort the model's own vocabulary accepts — the same
 * normalization `buildChatSamplingParams` uses for a real call — rather than inventing its own
 * guess at what a reasoning model will accept.
 */
export const callOpenAIResidencyProbeChatCompletion = (input: ResidencyProbeInput): Promise<unknown> =>
  probeClient("chat", input).chat.completions.create({
    model: input.model,
    messages: [{ role: "user", content: "x" }],
    max_completion_tokens: PROBE_MAX_OUTPUT_TOKENS,
    ...(isOpenAIGpt5Model(input.model)
      ? { reasoning_effort: normalizeOpenAIReasoningEffort(input.model, "minimal") as OpenAIChatReasoningEffort }
      : {}),
  });

/**
 * The default way the startup residency probe reaches OpenAI (or Azure OpenAI) for a rerank
 * model: a minimal `responses.create` call, matching how native-openai rerank actually calls it
 * (`OpenAISemanticRerankGateway`) rather than a chat completion. It sends no `reasoning.effort`:
 * the accepted values differ by model (gpt-5.4-mini's Responses endpoint rejects `"minimal"`
 * with a 400), the rerank path itself strips a rejected effort and retries, and a 400 here
 * would count as transient and leave the deployment unverified.
 */
export const callOpenAIResidencyProbeResponses = (input: ResidencyProbeInput): Promise<unknown> =>
  probeClient("rerank", input).responses.create({
    model: input.model,
    input: "x",
    max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
  });
