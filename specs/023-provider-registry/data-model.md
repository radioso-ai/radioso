# Data Model: Provider-Agnostic LLM Registry

## Provider Capability Config

- **Fields**:
  - `provider`: canonical provider name such as `openai`, `openai-compatible`, `gemini`, or `claude`
  - `model`: provider-specific model identifier
  - `baseUrl` (optional): custom base URL for OpenAI-compatible backends
  - `apiKeyEnv`: name of the secret source used by the provider adapter
- **Rules**:
  - Every model-backed capability resolves to exactly one provider capability config.
  - Unsupported provider-capability combinations are rejected during dependency resolution.

## Provider Capability Registry

- **Purpose**: Central resolver that maps named capabilities to provider adapters and exposes provider metadata.
- **Relationships**:
  - owns capability configs for `chat`, `embeddings`, `rewrite`, and `rerank`
  - constructs provider adapters from shared config and secrets
  - supplies gateway implementations to chat and retrieval services

## Provider Adapter

- **Purpose**: Focused integration boundary for one provider or protocol family.
- **Fields/Responsibilities**:
  - text completion request translation
  - streaming translation to plain text chunks
  - embedding request translation when supported
  - metadata reporting for provider/model path
- **Rules**:
  - adapters expose only the capabilities they actually support
  - adapters never leak provider-specific response shapes into orchestration services

## Provider Metadata

- **Fields**:
  - `provider`
  - `model`
  - `capability`
- **Purpose**: Enables logs, diagnostics, and test assertions to identify which path served a request without exposing secrets.
