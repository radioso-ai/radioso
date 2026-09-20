# Internal Inference Contract

Only `TextGenerationRequest` / `TextGenerationClient` change. An optional reusable boundary carries exact stable prefix and dynamic suffix alongside compatibility rendering. Adapters resolve `unsupported`, `implicit`, or `explicit_checkpoint` from configured provider/model/API mode: ordinary for unsupported, deterministic compatible ordinary request for implicit, native control at boundary for explicit.

This pilot does not retry provider cache-option errors. Unsupported or ineligible requests take the ordinary path before dispatch; every dispatched request keeps its original result or error. No implicit miss/expiry, cancellation, timeout, ambiguous dispatch failure, partial output, or unclassified error retries.

`ProviderUsage` gains transient normalized accounting with explicit `reported` or `unknown` state and optional independent reads/writes. Existing totals and durable events remain unchanged. There is no HTTP, SDK, MCP, connector, worker, AMQP, or database contract change.
