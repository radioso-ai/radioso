# Quickstart: Provider-Agnostic LLM Registry

## Validation scenarios

1. Run provider-registry unit tests to verify provider-capability validation and default resolution.
2. Run chat/retrieval domain unit tests to confirm existing gateway behavior still works with the new wiring.
3. Run backend contract tests if any HTTP-facing behavior changes unexpectedly during refactor. No contract change is expected for this feature.

## Manual smoke scenarios

1. Start the backend with only the default OpenAI configuration and confirm startup succeeds.
2. Start the backend with an alternate provider mapped to `chat` and confirm dependency construction succeeds.
3. Start the backend with Claude mapped to embeddings and confirm startup fails with a clear capability error.
4. Start the backend with an OpenAI-compatible base URL configured and confirm the registry resolves that provider separately from the default OpenAI path.
