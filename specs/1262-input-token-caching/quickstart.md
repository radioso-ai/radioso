# Validation Guide: Provider-Neutral Input Token Caching

Run focused provider, pipeline, prompt-composer/gateway, trace, and metrics tests. They prove request preservation, supported/unsupported mapping, retry boundaries, accounting-state normalization, bounded labels, and redaction; they never claim a live hit.

For provider-gated evaluation, hold resolved model, endpoint/API mode, region/environment, stable instructions, tool catalog, dynamic payload shape, and output limits fixed. Record cold, warm, expiry, stable-configuration-change, and concurrent observations with capability, accounting state/values, duration boundary/value, and confounders. Never record content, identities, credentials, cache handles, or raw models.

Wait for documented retention where controllable; otherwise record `expiry-not-observed/unknown`. A zero or absent read is not a miss unless explicit. Use p50/p95 only at 20 successful comparable observations per cohort; smaller cohorts report counts and descriptive/raw observations. Cached-token share needs compatible read and total definitions. Do not call either named duration TTFT or user-visible latency.

## Delivery validation record — 2026-09-19

The deterministic final run passed 186 tests across 12 focused files:

```bash
cd backend
pnpm exec vitest run tests/unit/input-token-caching.test.ts tests/unit/cache-telemetry.test.ts tests/unit/model-inference-pipeline.test.ts tests/unit/claude-provider-usage.test.ts tests/unit/gemini-provider-usage.test.ts tests/unit/turn-model-call-trace.test.ts tests/unit/stream-performance-metrics.test.ts tests/unit/model-chat-gateway.test.ts tests/unit/grounded-answer-prompt-contract.test.ts tests/unit/text-routed-tool-calling-gateway.test.ts tests/unit/llm-provider-registry.test.ts tests/unit/operatorCopilot/copilot-catalog-coverage.test.ts --reporter=dot
```

`cd backend && pnpm run build` and `pnpm run lint:dead-code:ci` passed. Root `pnpm run lint` reported four existing Enterprise billing type-resolution errors in `ee/packages/backend-module/src/billing/{billingWebhookHandler,planPricing}.ts`; both files were unchanged from `HEAD`.

No live provider evaluation was run. It needs configured provider credentials and controlled comparable cohorts, so this record makes no cache-hit, expiry, or latency-improvement claim.
