# Phase 1 Plan: Provider Usage Metadata

**Parent Spec**: [spec.md](./spec.md) — Delivery Split item 1
**Status**: Implemented (typecheck clean; backend unit suite green except one pre-existing unrelated `sourceUrl` citation failure on the base branch)
**Scope**: Provider result contracts only. No ledger changes (Phase 2), no recorder call-site wiring (Phase 4), no pricing (Phase 5), no UI (Phase 6).

## Goal

Make the provider layer *capable* of reporting actual token usage for non-streaming and streaming text generation and for embeddings, and make usage quality (actual vs estimated) explicit at the provider boundary. After Phase 1, a provider call can expose usage; nothing yet records it. This satisfies the Provider Result Rule and FR-008/FR-009/FR-010/FR-011 at the contract level.

## What each module knows (boundary decisions)

- **Provider adapters** (`shared/infra/llm/{openai,gemini,claude}Provider.ts`) own provider-specific usage extraction. Only they know SDK field names (`response.usage`, `usageMetadata`, `message_start.usage`). They translate to a single normalized shape.
- **`providerTypes.ts`** owns the normalized `ProviderUsage` shape and the result contracts. It knows nothing provider-specific and nothing about ledgers, pricing, or operations.
- **Gateway adapters** (`ModelChatGateway`, `ModelQueryRewriteGateway`, `ModelRerankGateway`, `ModelTriggerAnalysisGateway`, `ModelGroundedMissResponseComposer`, agent wizard, `OpenAISemanticRerankGateway`) consume the new result and, **in Phase 1, read `.text` and discard `.usage`.** They do not yet propagate usage upward. Widening gateway return types to carry usage to recording call sites is explicitly Phase 4 work.

This keeps Phase 1 a contained, behavior-preserving contract migration: text output is unchanged; usage becomes available and unit-tested at the adapter boundary. The dropped-at-gateway usage is a deliberate, documented shim for Phase 4, not speculative generality — the consumer is known and imminent.

## Contract shape (the expensive-to-reverse decision)

Add to `providerTypes.ts`:

```ts
export type UsageQuality = "actual" | "estimated";

// Raw provider-reported counts, normalized across SDKs. No cost, no pricing.
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;   // populated when the provider distinguishes it
  reasoningTokens?: number;     // populated when the provider distinguishes it
  providerRequestId?: string;
  quality: UsageQuality;        // "actual" iff the provider returned usage on this call
}

export interface TextGenerationResult {
  text: string;
  usage?: ProviderUsage;        // absent when the provider returned no usage at all
}

export interface TextGenerationStreamResult {
  textStream: AsyncIterable<string>;   // unchanged chunk semantics
  usage: Promise<ProviderUsage | undefined>; // resolves after the stream completes
}

export interface EmbeddingResult {
  vectors: number[][];
  usage?: ProviderUsage;
}
```

Change the client contracts:

```ts
export interface TextGenerationClient {
  readonly metadata: LlmProviderMetadata;
  complete(input: TextGenerationRequest): Promise<TextGenerationResult>;
  stream(input: TextGenerationRequest): TextGenerationStreamResult; // NOTE: now returns sync, not AsyncIterable
}

export interface EmbeddingClient {
  readonly metadata: LlmProviderMetadata;
  embedTexts(texts: string[], options?: { model?: string }): Promise<EmbeddingResult>;
}
```

**Why a result object for streaming instead of yielding a final usage sentinel:** FR-009 requires final usage to be exposed *separately from text chunks*. A heterogeneous async iterator (text-or-usage) forces every consumer to type-discriminate each yield. A `{ textStream, usage }` result keeps the chunk stream homogeneous and gives Phase 4 a single awaitable for final usage. Trade-off: `stream()` stops being directly `for await`-able; callers iterate `result.textStream`. This is a one-line change at each of the two streaming consumers.

**Streaming usage settlement rule:** `usage` resolves to the provider's final usage if delivered, to `undefined` if the stream ends without usage, and — if the stream throws mid-flight — resolves to whatever partial usage was seen (or `undefined`) rather than rejecting, so a streaming error never masks the text error already propagating through `textStream`.

## Edge-case decisions owed by the spec (resolved here)

- **Cost-on-failure / interrupted stream:** The adapter reports whatever usage the provider returned even on a failed or interrupted call; `quality` stays `"actual"` when those counts came from the provider. Phase 1 does not decide *recording* of failed calls (FR-014 is a Phase 4 call-site concern) — it only ensures the contract can carry usage alongside a thrown/partial result. Document this in the streaming settlement rule above.
- **Usage in final streaming event only:** handled by the `usage: Promise` design.
- **Estimated fallback:** Phase 1 does **not** compute estimates. When a provider returns no usage, the result carries `usage: undefined`. The estimation policy (char/token heuristics, marking `quality: "estimated"`) belongs to the recording layer in Phase 4, because estimation needs the operation's token-counting context, not the raw SDK call. The contract only distinguishes "provider gave actual usage" from "no usage available."

## Per-adapter extraction notes (verified against current SDK usage)

- **OpenAI (`openaiProvider.ts`)**: non-streaming reads `response.usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`). Streaming must pass `stream_options: { include_usage: true }`; the final chunk carries `usage`. Embeddings read `response.usage` (`prompt_tokens`). `response.id` → `providerRequestId`.
- **Gemini (`geminiProvider.ts`)**: reads `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `cachedContentTokenCount`). Streaming exposes `usageMetadata` on the final aggregated response.
- **Claude (`claudeProvider.ts`)**: non-streaming reads `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`). Streaming: `message_start` carries input tokens, `message_delta` carries cumulative `output_tokens`. `message.id` → `providerRequestId`.

## Consumer churn (must all land together to keep the build green)

`.complete()` → read `.text`: `ModelChatGateway.answer`, `ModelQueryRewriteGateway.rewrite`, `ModelTriggerAnalysisGateway.analyze`, `ModelRerankGateway.rerank`, `ModelGroundedMissResponseComposer`, `agentWizard/service.callLlm`.
`.stream()` → iterate `.textStream`: `ModelChatGateway.streamAnswer`, `ContextualChatGateway.streamAnswer`.
`embedTexts()` → read `.vectors`: `embeddingService` and any direct callers.
`OpenAISemanticRerankGateway` uses the raw OpenAI SDK directly and is unaffected by the contract change (revisit in Phase 4).

This is the full blast radius: ~8 adapter classes in `shared/infra/llm` + `chat` + `retrieval` + `agentWizard`. It is one reviewable PR; it must not be split below this point because the TS contract change is atomic.

## TDD task order

1. **Contract types** in `providerTypes.ts` (no behavior).
2. **OpenAI adapter** — failing unit tests first: non-streaming returns `{ text, usage }` with mapped fields + `quality:"actual"`; non-streaming with absent usage → `usage: undefined`; streaming yields same text chunks and `usage` promise resolves from the final chunk; streaming without `include_usage`/final usage → `usage` resolves `undefined`; embeddings return `{ vectors, usage }`. Then implement.
3. **Gemini adapter** — same test matrix against `usageMetadata`. Then implement.
4. **Claude adapter** — same matrix against `message_start`/`message_delta`. Then implement.
5. **Consumer unwrap** — update the gateway adapters + streaming consumers to `.text` / `.textStream` / `.vectors`. Existing gateway/service tests must stay green unchanged (text behavior preserved); adjust only mocks that returned bare strings/vectors to return result objects.
6. **Typecheck + focused suites**: `pnpm --filter backend test:unit` for the touched files, then `pnpm run ci:local -- origin/main`.

## Out of scope (guardrails)

- No `recordModelCall`/`recordEmbedding` changes, no ledger, no rollups, no pricing, no summaries, no UI.
- No estimation heuristics (Phase 4).
- No widening of gateway/service return types to carry usage upward (Phase 4).
- No SDK/OpenAPI/public-contract changes — this is an internal provider contract; `FR-033` (additive public API) does not apply here. Confirm no public type re-exports `TextGenerationClient`.

## Acceptance criteria

- All three adapters return provider-reported usage with `quality:"actual"` when the SDK supplies it, and `usage: undefined` when it does not, for non-streaming, streaming, and (where applicable) embeddings.
- Text output and streaming chunk behavior are byte-for-byte unchanged for all existing consumers (existing tests pass with only mock-shape updates).
- `stream()` exposes final usage via a promise that never rejects on stream error.
- Build, typecheck, and focused unit suites are green; `ci:local` passes.
