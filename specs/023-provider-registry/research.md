# Research: Provider-Agnostic LLM Registry

## Decision: Model providers by capability, not by one global client

**Rationale**: Chat generation, streaming, embeddings, rewrite, and rerank have different support across vendors. A capability-based registry lets the system reject invalid mappings such as Claude for embeddings while still allowing Claude for chat, rewrite, or rerank.

**Alternatives considered**:
- One global provider setting for every LLM action: rejected because capability coverage differs by vendor.
- Keeping separate ad hoc env vars per current use case: rejected because it preserves OpenAI-centric coupling.

## Decision: Keep existing gateway interfaces as the application boundary

**Rationale**: `ChatGateway`, `EmbeddingGateway`, `QueryRewriteGateway`, and `RerankGateway` already isolate model-backed concerns from orchestration. Replacing direct OpenAI implementations behind those seams avoids unnecessary churn in chat and retrieval orchestration code.

**Alternatives considered**:
- Replace the app boundary with LangChain or another orchestration framework: rejected because it expands scope and weakens the repo’s current clear service seams.
- Collapse all model-backed work into one large generic client: rejected because it would couple unrelated prompts, output parsing, and fallback behavior.

## Decision: Use OpenAI SDK for OpenAI and OpenAI-compatible backends, native fetch for Gemini and Claude

**Rationale**: The repo already depends on the OpenAI SDK, and OpenAI-compatible backends can reuse that transport with a configurable base URL. Gemini and Claude can be integrated with focused REST adapters, avoiding additional dependency sprawl while keeping provider code isolated.

**Alternatives considered**:
- Add official SDKs for every vendor: rejected for the first pass because it increases dependency churn without improving the application boundary.
- Use raw fetch for every provider including OpenAI: rejected because the repo already has a working OpenAI integration path.

## Decision: Keep GPT-5.2 as the default provider path through config defaults

**Rationale**: The constitution requires GPT-5.2 as the default provider. Provider-neutral env parsing can still expose alternate providers while defaulting chat, rewrite, rerank, and embeddings to the existing OpenAI path.

**Alternatives considered**:
- Default to a generic provider-neutral placeholder: rejected because it would violate the constitution and make startup ambiguous.

## Decision: Validate incompatible provider-capability combinations at startup/dependency resolution

**Rationale**: Failing early gives operators a clear error before requests flow through production. This is especially important because Claude will not satisfy embeddings in this feature, while other providers may support only selected capabilities.

**Alternatives considered**:
- Lazy failure only when a request hits the unsupported capability: rejected because it would create less predictable operational behavior.
