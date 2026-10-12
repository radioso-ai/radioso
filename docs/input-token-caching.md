---
title: "Input Token Caching"
description: "How Radioso makes stable model input eligible for provider token caching and how to evaluate the result."
last_updated: 2026-10-12
---

# Input Token Caching

Most of what a model reads on a turn is the same from one turn to the next: the agent's instructions, the planning rules, the answer format. Providers bill a reused prefix of that input at a fraction of the normal rate, but only when the shared part comes first and is byte-for-byte identical. Radioso orders its prompts so standing instructions lead, marks where they end, and lets each provider reuse what it can. The provider decides whether a particular request reuses a cached prefix.

## What becomes eligible

The eligible prefix holds standing instructions and the agent's own configuration. Everything that changes per turn follows it: the current message, conversation history and summaries, visitor context, retrieved results, tool results, and turn-specific steering.

- **Turn planning.** The planning rules come first, followed by the agent's retrieval rewrite guidance, the channel's page-read capability, and the agent's directive conditions in name order. This turn's routine candidates and the output shape follow. The visitor context, conversation, and latest question form the separate request.
- **Grounded answers.** The agent's base instructions come first, followed by the coverage verdict, coverage guidance, and output envelope rules. Turn steering, an alternative-interpretation offer, the follow-up question rules, and a routine lead-back follow. The base instructions include the response language and the current UTC date, so this prefix is shared by turns that answer in the same language on the same day.
- **Agent tool steps.** The agent's instructions, protocol, and tool catalog form the prefix of every step. The transcript follows.

Response schemas are part of what a provider compares. The turn planner represents each routine candidate by a position (`r1`, `r2`, …) rather than its real id, up to the bound on routine candidates a single call accepts, so the schema is the same whatever candidates the embedding prefilter returned this turn or what order it returned them in. It still changes between a turn that has routine candidates and one that has none, between a turn that has directive candidates and one that has none, and between a channel that advertises page-read and one that doesn't. Directive names stay a sorted enum of this turn's candidate names — stable turn to turn because that candidate set comes from the agent's configuration, not the query. A grounded answer's directive-adherence attestation is a plain id string present on every turn, whether or not this turn renders any attestable rule; resolving it drops an id the model invented or one not actually rendered this turn.

A change to the standing instructions, directive conditions, tool catalog, response schema, provider, model, or API mode produces a different prefix, and the next request starts a fresh cache entry.

## How each provider uses the prefix

- **Claude** configurations that support an explicit checkpoint place one at the end of the prefix.
- **Gemini** configurations that support implicit caching receive a deterministic compatible request.
- **OpenAI** caches matching prefixes automatically. When a request carries a reusable prefix, Radioso adds a `prompt_cache_key` so requests that can share a cache reach the same one. The key is a hash of the reusable prefix and the response schema; it changes only when that content does, and OpenAI receives no workspace, account, or conversation identifier through it. OpenAI recommends keeping each key near 15 requests per minute; an agent that runs hotter than that on one kind of call spreads across more of OpenAI's cache machines and sees a lower hit rate.
- **OpenAI-compatible endpoints**, and OpenAI configurations with a custom base URL, receive their ordinary request.

Other unsupported providers, models, and endpoints use the ordinary request path. A cache miss, expiry, eviction, or unavailable implicit cache does not retry the generation.

A provider only caches prefixes above its minimum length. For OpenAI that is around 1,024 tokens and varies with the model and request settings. The shared part of a reranking prompt is shorter than that, so reranking calls do not reuse cached input.

## When a provider rejects a cache option

If OpenAI rejects `prompt_cache_key` for a model, Radioso sends the same request again without it and leaves the key off later requests for that endpoint, model, and API key. The key only routes requests, so the generation is the same either way.

Every other native cache option keeps its original outcome once the request reaches the provider: Radioso keeps the result or error as it came back, including streamed text, cancellation, timeout, partial output, ambiguous dispatch, and unclassified failures. Unsupported and ineligible requests use the ordinary path before dispatch.

## Reading cache telemetry

The backend records bounded operational metadata for each model call. Cache accounting distinguishes provider-reported reads and writes, reported zero, and unknown accounting. OpenAI's `cached_tokens` count is recorded as cache-read accounting. An absent accounting field is unknown; neither it nor a reported zero proves a miss. Providers can differ on whether a cached read is included in their input-token total, so compare cached-token share only when both values use compatible definitions.

Each model call in a turn trace carries `cachedInputTokens` and its cache accounting, which is the quickest way to check one conversation.

Two duration boundaries are available:

- `provider_invocation_duration` begins when the adapter starts a non-streaming provider call and ends when that call completes or fails.
- `adapter_first_text_duration` begins at the same point and ends when the adapter yields the first stream text.

Both include request serialization, transport, provider work, and buffering. They help compare provider-call behavior but are not model time to first token or the time a person waits for an answer.

Metrics use bounded operation/surface, provider family, model group, cache capability, accounting state, outcome, and timing-boundary labels. First-party OpenAI reports the `implicit` capability. Turn planning, answers, and agent tool steps each have their own operation label. Metrics do not include prompts, completions, retrieved text, workspace or conversation identities, request IDs, credentials, cache handles or keys, raw model names, or provider secrets.

The exported metrics are `radioso_llm_input_cache_requests_total`, `radioso_llm_inference_timing_duration_ms`, `radioso_llm_input_cache_read_input_tokens`, and `radioso_llm_input_cache_write_input_tokens`. The `radioso_` prefix is added by the metrics registry.

## Evaluate a provider configuration

Use the same resolved model, endpoint or API mode, region, stable instructions, tool catalog, dynamic payload shape, and output limit for each comparable observation. Record the capability, cache-accounting state and values when reported, the duration boundary and value, and any confounder such as provider load or a configuration change.

Run these conditions:

1. Make a cold request, then repeated equivalent warm requests. For a chat agent, the simplest warm pair is two turns in one conversation sent within a minute: the second turn's planning and answer calls should report cached input as long as both turns agree on whether they have routine candidates, directive candidates, and page-read capability — those presences, not the candidates themselves, are what the response schema partitions on.
2. Wait for documented provider retention when you can control it, then record an expiry observation. If retention cannot be controlled, record `expiry-not-observed/unknown`.
3. Change stable configuration such as instructions or tools, then make an otherwise comparable request.
4. Run concurrent equivalent requests and keep each outcome separate. Concurrent calls do not promise shared cache locality.

The first turn of a conversation on a quiet agent reports no cached input, because nothing has warmed its prefix yet. Use p50 and p95 only when both comparable cohorts have at least 20 successful observations. For smaller cohorts, report the observation count and descriptive or raw values. Do not manufacture a cache hit, a miss, an expiry, or a latency improvement from missing provider accounting.
