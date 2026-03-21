# Internal Contract Notes: Provider Capabilities

## Capability surface

The provider registry must be able to resolve these internal capabilities:

- `chat`: text completion plus streaming support
- `embeddings`: vector generation for retrieval and chunking
- `rewrite`: text completion used by query rewrite
- `rerank`: text completion used by semantic rerank

## Resolution rules

1. Each capability resolves independently from configuration.
2. The registry returns a focused adapter implementation for the requested capability.
3. If a provider does not support a requested capability, dependency construction fails with a clear error.
4. Providers may share transport plumbing while remaining distinct operator choices, such as `openai` vs `openai-compatible`.

## Translation rules

- Chat streaming must normalize provider-specific streaming payloads into plain text chunks for `ChatGateway.streamAnswer()`.
- Rewrite and rerank adapters must return plain text or parsed JSON strings compatible with existing service-level parsing and fallback behavior.
- Embedding adapters must return numeric arrays compatible with the current `EmbeddingGateway` contract.

## Metadata expectations

Each resolved capability should expose non-secret metadata identifying:

- provider name
- model name
- capability name

This metadata may be used in logs, diagnostics, and tests.
