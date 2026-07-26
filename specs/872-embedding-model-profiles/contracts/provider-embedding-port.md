# Internal Contract: Supported Embedding Provider

This is an internal TypeScript port, not a new HTTP resource.

```ts
type EmbeddingPurpose = "retrieval_document" | "retrieval_query";

interface SupportedEmbeddingModelDescriptor {
  model: CurrentEmbeddingModel; // existing four-model enum
  provider: "openai" | "gemini";
  dimensions: { native: number; supported: readonly number[] };
  normalization: "provider_unit" | "application_unit";
  tasks: Record<EmbeddingPurpose, string>;
  limits: { maxBatch: number; maxInputBytes: number; maxResponseBytes: number };
}

interface EmbeddingProviderPort {
  probe(input: FixedProbeRequest): Promise<ProbeResult>;
  embed(input: EmbeddingRequest): Promise<EmbeddingBatch>;
}
```

Every request carries explicit workspace binding, descriptor, purpose and expected
dimensions. The port rejects count mismatch, mixed/wrong dimensions, non-finite values,
zero cosine norm, normalization breach, timeout and size-limit breach. Provider
adapters own SDK payload/task mapping. Model-name prefix routing is forbidden.

The fixed probe contains no customer text and returns only sanitized validation status
to settings orchestration.

