# Feature Specification: Retrieval Clarification Label Reuse

**Status**: Reverted / superseded — retained as experiment record

> The clarification-result reuse layer described below was removed after the local
> benchmark found no eligible reuse hits and no demonstrated latency benefit. The
> generic provider input-token caching work remains separate. Benchmark evidence is
> retained under `.context/input-token-caching-benchmarks/local-instance/`.

## Goal

Avoid a repeated retrieval-sense label-model call only when the same current retrieval evidence has already received a complete, non-exclusive label decision moments earlier. This is a short-lived decision reuse, not an answer cache.

## Requirements

- Keep the existing grouping and embedding checks on every request. Fewer than two groups already avoids the label call and is not this feature.
- After two or more separated groups are assembled, reuse only an unexpired, bounded in-memory result for the exact label input.
- Store only results where every separated group has one valid nonempty generated label and an explicitly parsed `complementary` or `redundant` relationship.
- Any exclusive, missing, malformed, duplicate, partial, failed, expired, evicted, or unsupported-scope result follows the current gateway path.
- The key covers workspace and semantic/security scope, effective provider/model/configuration/credential-realm identity, prompt template, grouping policy, question, language, and ordered current group/candidate material including chunk IDs and complete chunk content. It is hashed; no key material is logged.
- A hit returns equivalent candidates while retaining the current request's confidence and diagnostic usage context. Fresh authorized retrieval still supplies current candidates each turn.
- The cache has a five-minute TTL, fixed capacity of 64, injectable clock tests, and no in-flight sharing or durable storage.
- A content-free bounded metric records `hit`, `miss`, `structural_skip`, `bypass_missing_scope`, and `noncacheable_label_result`, so benchmark reports distinguish an avoided model call from pre-existing structural skips. It makes no latency claim.
- No API, SDK, MCP, UI, settings, database, worker, or queue contract changes. This internal retrieval behavior has no operator copilot action; the existing retrieval coverage remains applicable.

## Acceptance Scenarios

1. A repeated identical two-group complementary/redundant assessment across different conversation/request IDs calls the real label gateway once and returns equivalent candidates on its second detection.
2. Changing question, language, workspace/security scope, model/provider/configuration realm, prompt, policy, group order, metadata, excerpts, chunk ID, or full chunk content misses.
3. Exclusive, missing, duplicate, partial, invalid, and failed labels never populate or consume reuse; expiry and LRU eviction miss.
4. Existing fewer-than-two-group behavior still calls neither embeddings nor labels.

## Out Of Scope

Planner eligibility changes, answer/citation caching, model selection changes, prompt changes, and cross-process/durable reuse.

## Validation Result

The isolated 20-turn local after cohort observed zero `hit` outcomes and 21 each of `miss` and `noncacheable_label_result` including warm-up. Each measured turn retained four model calls, including clarification. TTFT p50/p95 was 4,330/5,061 ms against the baseline's 3,569/4,183 ms. With no reuse hit and uncontrolled provider/network variance, this does not show that the change caused the slower timing; it does establish that this workload did not demonstrate a performance improvement. See `.context/input-token-caching-benchmarks/local-instance/REPORT-FASTPATH-LOCAL.md`.
