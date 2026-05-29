import type { ProviderUsage, TextGenerationStreamResult } from "./providerTypes.js";

/**
 * Adapts a provider streaming generator into a {@link TextGenerationStreamResult}.
 *
 * The provided generator yields text chunks and returns the final
 * {@link ProviderUsage} (or `undefined` when the provider reported none). This
 * helper exposes the chunks through `textStream` and resolves `usage` from the
 * generator's return value once iteration completes. If the generator throws,
 * the error propagates through `textStream` and `usage` still resolves (to the
 * usage seen so far, typically `undefined`) rather than rejecting — so a usage
 * failure can never mask the streaming error the caller is already handling.
 *
 * `usage` only settles once `textStream` is driven to completion; callers that
 * need usage must consume the stream first.
 */
export const streamWithUsage = (
  generate: () => AsyncGenerator<string, ProviderUsage | undefined, void>,
): TextGenerationStreamResult => {
  let resolveUsage!: (usage: ProviderUsage | undefined) => void;
  const usage = new Promise<ProviderUsage | undefined>((resolve) => {
    resolveUsage = resolve;
  });

  const textStream = (async function* () {
    const iterator = generate();
    let captured: ProviderUsage | undefined;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          captured = next.value ?? undefined;
          break;
        }
        yield next.value;
      }
    } finally {
      resolveUsage(captured);
    }
  })();

  return { textStream, usage };
};
