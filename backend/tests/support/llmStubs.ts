import type {
  ProviderUsage,
  TextGenerationResult,
  TextGenerationStreamResult,
} from "../../src/shared/infra/llm/providerTypes.js";

/** Build a non-streaming provider result for tests. */
export const textResult = (text: string, usage?: ProviderUsage): TextGenerationResult => ({
  text,
  usage,
});

/** Build a streaming provider result whose usage promise resolves immediately. */
export const streamResult = (
  chunks: string[],
  usage?: ProviderUsage,
): TextGenerationStreamResult => ({
  textStream: (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })(),
  usage: Promise.resolve(usage),
});
