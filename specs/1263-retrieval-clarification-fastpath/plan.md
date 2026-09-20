# Implementation Plan: Retrieval Clarification Label Reuse

> **Reverted / superseded.** This experiment was removed after the local benchmark
> produced no eligible reuse hits and no demonstrated latency benefit. Retained for
> decision history; benchmark evidence remains in `.context/`.

## Design

`SenseGroupingService` owns a private bounded LRU because the chat builder already creates one process-lifetime detector. It continues to own grouping, separation, and label interpretation; chat and the planner are unchanged.

After it has created canonical `SenseLabelGroup`s, the service requests an opaque resolved label-decision scope from the actual label gateway. The scope carries provider/model/prompt/configuration/credential-realm identity without raw credentials. If absent, reuse is bypassed. It hashes stable serialized current input: workspace and agent scope, question/language, opaque gateway scope, policy, ordered label groups, and complete separated chunk material. It intentionally excludes conversation, request, message, and attempt correlation IDs. Raw inputs never leave the service through telemetry or logs.

On a cache hit the service reuses only labels and rebuilds candidates against the current separated groups, retaining current confidence and usage context. On a miss it calls the existing gateway. Only a one-to-one, unique, nonempty, all-non-exclusive parsed response is saved. The cache uses a 5-minute TTL and 64-entry LRU; injected clock and limits are construction options.

## Boundaries

| Owner | Responsibility |
|---|---|
| `senseGroupingService.ts` | Canonical input, validation, private ephemeral reuse |
| actual label gateway | Opaque resolved model/configuration scope |
| `chat.ts` | Existing singleton construction only; no new registry or lifecycle |
| focused service tests | Gateway-call avoidance and conservative miss cases |

No public or operator surface is created. Existing model-call tracing records actual misses; cache keys and raw inputs are never logged.

The retrieval-owned `retrieval_sense_label_reuse_total` counter has only fixed outcome labels: `hit`, `miss`, `structural_skip`, `bypass_missing_scope`, and `noncacheable_label_result`. It measures repeated-decision eligibility rather than answer quality or TTFT.

## Validation

Write failing service tests first, then run the focused suite, backend build, root lint, and the touched-file dead-code gate.

The local benchmark is a repeat-only cohort check: it must report cache outcomes and real label-call counts before interpreting TTFT. Its completed 20-turn cohort produced no reuse hit, so it did not demonstrate the planned latency benefit and must not be used as a performance claim.
