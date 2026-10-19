import { createOpenAIClient } from "./openaiProvider.js";

/**
 * The default way the startup residency probe (`backend/src/runtime/openAIResidencyStartupCheck.ts`)
 * reaches OpenAI: one embeddings call built through the same pinned client factory every other
 * native `openai` call uses, so the probe reaches the exact host a real embedding call would.
 * Lives here, not in `src/runtime/`, because vendor-specific client modules
 * (`openaiProvider.ts`) are importable only from within this directory
 * (`no-llm-vendor-providers-outside-llm-infra`).
 */
export const callOpenAIResidencyProbeEmbeddings = (input: {
  apiKey: string;
  residency: "us" | "eu";
  model: string;
}): Promise<unknown> => {
  const client = createOpenAIClient({
    capability: "embeddings",
    provider: "openai",
    model: input.model,
    apiKey: input.apiKey,
    openAIDataResidency: input.residency,
  });
  return client.embeddings.create({ model: input.model, input: "x" });
};
