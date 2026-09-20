# Implementation Plan: Provider-Neutral Input Token Caching

**Branch**: `1262-input-token-caching` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

## Summary

Add one internal, role-preserving reusable-input boundary: an exact contiguous stable system prefix and following dynamic suffix. The grounded-answer composer and text-routed agent gateway identify standing instructions and supplied tool catalog; inference transports it unchanged; Claude maps explicit capability to its checkpoint, Gemini maps implicit capability to its compatible ordinary request, and unsupported configurations remain ordinary requests.

Normalize cache read/write availability without changing the durable usage ledger. Add bounded metrics and safe transient trace diagnostics. No public API, SDK, MCP, connector, AMQP, worker, database, settings, UI, cache object, prewarm, response cache, or routing change is introduced.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24
**Primary Dependencies**: Express, Zod, provider HTTP adapters, Vitest
**Storage**: PostgreSQL unchanged; cache metadata is request-local/transient
**Testing**: Focused Vitest tests, metrics rendering test, provider-gated evaluation procedure
**Target Platform**: Self-hosted backend and worker runtime
**Project Type**: Node.js web service with shared inference infrastructure
**Performance Goals**: Make safe prefixes eligible; measure rather than promise improvement
**Constraints**: Exact bytes/roles/order; no dynamic promotion; unsupported no-op; only proven pre-generation option rejection retries; bounded telemetry; no durable cache fields
**Scope**: Grounded answers and text-routed agent steps; Claude explicit checkpoint and Gemini implicit path

## Constitution Check

*Pre-design: PASS. Post-design: PASS.*

| Principle | Plan response |
|---|---|
| Spec-first / backend TDD | Reviewed spec gates delivery; failing focused Vitest coverage precedes production slices. |
| Stack / secrets | Existing TypeScript adapters and metrics only; no configuration or secret. |
| Modularity | Semantic split stays in composer/gateway, native rendering in adapters, telemetry in focused helper. |
| Data / reliability | No content, identity, or credentials in telemetry; no duplicate generation after ambiguous/streaming failure. |
| Contracts / docs | Internal inference contract only; no OpenAPI/SDK/queue change; document operational evaluation. |
| Prompt assets | No prompt asset is added or moved. |

## Module boundaries and dependency direction

| Module | Knows | Must not know | Port / direction |
|---|---|---|---|
| `groundedAnswerPromptComposer.ts` | Stable answer-system blocks before dynamic conversation/retrieval | Provider checkpoints/telemetry | Produces neutral boundary for the chat gateway port. |
| `chatGateway.ts` / `chatGateways.ts` | Passing the neutral boundary from chat into inference | Cache eligibility/rendering | Defines and forwards the chat transport field unchanged. |
| `textRoutedGateway.ts` | Stable agent instructions, protocol, supplied-order tool catalog | Provider controls/cache hits | Produces neutral boundary for pipeline. |
| `providerTypes.ts` + focused cache module | Boundary, accounting state, bounded capability names | Prompt policy/native HTTP payloads | Defines narrow internal port. |
| `modelInferencePipeline.ts` | Boundary transport, budget, telemetry/trace recording | Prompt semantics/native fields | Depends on contract and adapter port. |
| `claudeProvider.ts`, `geminiProvider.ts` | Provider/model/API-mode capability, rendering, native fields, usage extraction | Product semantics/database/metrics identity | Implement adapter port. |
| cache telemetry helper | Fixed metrics/labels/duration boundaries | Raw request/result content and durable schema | Called by pipeline through `MetricsRegistry`. |
| `app/composition/` | Default assembly and injection of the existing metrics registry into the pipeline | Eligibility/rendering rules | Wires an existing observability dependency only; it owns no cache policy. |

Direction: composer/gateway → neutral inference contract → pipeline → provider adapter. Adapters never import chat/agent runtime; composition only assembles clients.

## Design decisions

1. Add optional `reusableInputBoundary` to `TextGenerationRequest`: ordered role-preserving `stableSystemPrefix`/`dynamicSystemSuffix` segments and one breakpoint. Builders derive it and compatibility `systemPrompt`/`prompt` from the same immutable parts. `ChatGatewayInput` and `ModelChatGateway` forward it unchanged to inference.
2. Resolve `unsupported`, `implicit`, or `explicit_checkpoint` from selected provider family, model, and API mode/endpoint in adapter-local infrastructure. Unsupported is default; no app-wide registry.
3. Claude serializes eligible prefix into native content blocks with checkpoint at its end. Gemini uses deterministic compatible ordinary request for implicit reuse; no cached-content object. Ineligible/unsupported requests serialize as before.
4. Normalize explicit accounting availability plus optional finite non-negative reads/writes. Preserve input/output/total semantics and document each provider’s total-input interpretation. Durable events stay unchanged.
5. Emit bounded metric/diagnostic labels: surface/operation, provider family, bounded model group, capability, accounting state, outcome, timing boundary. Measure complete `provider_invocation_duration` and streamed `adapter_first_text_duration` only after yielded text; neither is TTFT/user-visible latency.
6. This pilot does not retry provider cache-option errors: a request that reaches provider dispatch retains its original result or error. Ordinary unsupported/ineligible requests are rendered without native cache controls before dispatch. A future retry needs a provider error contract proving pre-generation rejection.

## Contract and integration impact review

| Surface | Conclusion |
|---|---|
| HTTP/OpenAPI and TypeScript SDK | No route/payload/status/OpenAPI change; no SDK sync. |
| MCP and connectors | No contract or endpoint change. |
| Document worker/AMQP | No payload, dispatch, retry, test, or queue-doc change; request is in process. |
| Database/durable usage ledger | No schema/migration/backfill/cache fields. |
| Composition | Pass the existing `MetricsRegistry` to the default `ModelInferencePipelineService` construction so production telemetry is emitted. No new registry, lifecycle, or capability-policy wiring. |
| Operator copilot coverage | Permanent coverage-map exclusion: runtime-internal telemetry has no safe Ray operation. |
| Observability | Bounded metrics and transient diagnostics; no sensitive logs. |

## Project Structure

```text
backend/src/shared/infra/llm/              # contract, pipeline, adapters
backend/src/shared/observability/metrics/  # MetricsRegistry
backend/src/shared/agent-runtime/           # text-routed gateway
backend/src/modules/chat/services/          # grounded composer
backend/src/modules/operatorCopilot/         # coverage exclusion
backend/tests/unit/                         # regressions
docs/                                       # evaluation guide
specs/1262-input-token-caching/             # design and tasks
```

**Structure Decision**: Extend the backend LLM seam with one focused shared contract/helper; add no product module, persistence layer, or frontend surface.

## Complexity Tracking

No constitution violations or complexity exceptions.
