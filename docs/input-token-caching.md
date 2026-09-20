---
title: "Input Token Caching"
description: "How Radioso makes stable model input eligible for provider token caching and how to evaluate the result."
last_updated: 2026-09-19
---

# Input Token Caching

Radioso can mark the stable leading instructions of a grounded answer or an agent tool step as reusable input when the selected model provider supports it. The request still contains the same instructions, retrieval context, conversation data, and current message in the same order. The provider decides whether it can reuse the prefix for a particular request.

## What becomes eligible

The eligible prefix contains only standing instructions and the supplied tool catalog before the first volatile input. Current messages, retrieval output, conversation summaries, tool results, and turn-specific steering remain dynamic. A change to the stable instructions, tool catalog, provider, model, or API mode naturally produces a different request shape for the provider.

Claude uses its native checkpoint mechanism for configurations that support an explicit checkpoint. Gemini configurations that support implicit caching receive a deterministic compatible request. OpenAI and OpenAI-compatible adapters keep their ordinary request shape: Radioso records provider-reported `cachedInputTokens` when present, but does not normalize cache accounting, declare cache capability, or render an explicit reusable-input boundary for them. Any automatic caching therefore depends on the selected provider and endpoint. Other unsupported providers, models, endpoints, and ineligible prefixes use the ordinary request path. A cache miss, expiry, eviction, or unavailable implicit cache does not retry the generation.

This pilot does not retry a provider error caused by a native cache option. Unsupported and ineligible requests use the ordinary path before dispatch. Once a request has reached a provider, Radioso keeps its original result or error; that includes streamed text, cancellation, timeout, partial output, ambiguous dispatch, and unclassified failures.

## Reading cache telemetry

The backend records bounded operational metadata for each model call. Cache accounting distinguishes provider-reported reads and writes, reported zero, and unknown accounting. An absent accounting field is unknown; neither it nor a reported zero proves a miss. Providers can differ on whether a cached read is included in their input-token total, so compare cached-token share only when both values use compatible definitions.

Two duration boundaries are available:

- `provider_invocation_duration` begins when the adapter starts a non-streaming provider call and ends when that call completes or fails.
- `adapter_first_text_duration` begins at the same point and ends when the adapter yields the first stream text.

Both include request serialization, transport, provider work, and buffering. They help compare provider-call behavior but are not model time to first token or the time a person waits for an answer.

Metrics use bounded operation/surface, provider family, model group, cache capability, accounting state, outcome, and timing-boundary labels. They do not include prompts, completions, retrieved text, workspace or conversation identities, request IDs, credentials, cache handles, raw model names, or provider secrets.

The exported metrics are `radioso_llm_input_cache_requests_total`, `radioso_llm_inference_timing_duration_ms`, `radioso_llm_input_cache_read_input_tokens`, and `radioso_llm_input_cache_write_input_tokens`. The `radioso_` prefix is added by the metrics registry.

## Evaluate a provider configuration

Use the same resolved model, endpoint or API mode, region, stable instructions, tool catalog, dynamic payload shape, and output limit for each comparable observation. Record the capability, cache-accounting state and values when reported, the duration boundary and value, and any confounder such as provider load or a configuration change.

Run these conditions:

1. Make a cold request, then repeated equivalent warm requests.
2. Wait for documented provider retention when you can control it, then record an expiry observation. If retention cannot be controlled, record `expiry-not-observed/unknown`.
3. Change stable configuration such as instructions or tools, then make an otherwise comparable request.
4. Run concurrent equivalent requests and keep each outcome separate. Concurrent calls do not promise shared cache locality.

Use p50 and p95 only when both comparable cohorts have at least 20 successful observations. For smaller cohorts, report the observation count and descriptive or raw values. Do not manufacture a cache hit, a miss, an expiry, or a latency improvement from missing provider accounting.
