# Research: Planet Managed Models

## BYOK Credential Trace

### Finding: BYOK currently leaks platform credentials

`EnterpriseManagedModelPolicy` returns `null` for a catalog plan whose `models` value is `byok`. `WorkspaceLlmCapabilityResolver` interprets that only as “do not replace the selected model”; after a missing workspace credential, `resolveApiKey` unconditionally asks `envKeys` and returns the deployment credential. The same fallback applies to embeddings because the resolver deliberately skips managed-model selection for the embedding capability but still resolves credentials through the same method.

The leak is a missing policy fact, not a call-site-specific bug: `null` conflates a BYOK plan, an unassigned Enterprise account, and unrestricted self-hosting. The resolver needs one policy decision containing both the optional managed-model selection and whether platform credentials are allowed.

### End-to-end consumers

- Chat turns use `LlmProviderRegistry.createChatGateway` and the contextual gateways. They resolve the workspace chat capability before client construction.
- Turn planning, answer generation, fallback replies, routing, interpretation, response-language detection, handoff copy, directive matching, routine model decisions, coverage assessment, and retrieval rewrite/rerank use either contextual factories or registry inference pipelines. Registry pipelines resolve with `operation.workspaceId`; contextual factories carry an explicit `workspaceContext`.
- Ray/copilot uses `createToolCallingGateway`. The underlying inference pipeline resolves from the `copilot_turn` usage context's workspace id. Its availability endpoint probes `llmCapabilityResolver.resolve("chat", { workspaceId })`; a denied BYOK fallback therefore reaches the existing `no_llm_capability` state and “Connect an LLM to use Ray” UI.
- Document enrichment and the document worker use registry inference/embedding gateways. Document processing and embedding-profile jobs carry `job.workspaceId` in their embedding usage context. `ProfileBoundEmbeddingPorts` preserves that context into the embedding gateway.
- Retrieval query embeddings, routine-trigger embeddings, clustering/facet embeddings, and embedding-model probes carry a workspace id to `resolveCredentialedConfig`; provider/model metadata inspection does not construct a credentialed client.
- Suggested questions are fields of the same grounded-answer envelope and are filtered deterministically afterward; there is no separate suggestion-provider client.
- Conversation summaries and early titles use the rewrite inference pipeline and build a usage context containing the conversation workspace id.
- Direct provider client creation is confined to the shared LLM adapters/registry. Workspace runtime composition attaches `WorkspaceLlmCapabilityResolver` before document, retrieval, chat, Ray, and worker services are built.

### Decision

Replace the ambiguous `resolveManagedModel` result with one `resolveModelPolicy` decision:

- `managedModel`: optional provider/model replacement.
- `platformCredentials`: `allowed` or `denied`.

The OSS no-op policy returns no model replacement and allows deployment credentials, preserving self-host behavior. The Enterprise policy returns denied for every capability on a BYOK catalog plan, allowed plus the existing text-model selection on a managed plan, and unrestricted behavior for unknown/unassigned profiles to preserve the current non-catalog contract. The resolver always tries a workspace credential first, then consults the policy fact before reading the environment key.

One policy lookup per capability resolution avoids a second database query on managed calls. The resolver remains unaware of plan ids and catalog semantics.

## Planet Managed Variant

### Catalog units and inference rate

`priceCents` and `annualPriceCents` are integer euro cents. Satellite is €149/month for 1,000 conversations and includes managed models. Its managed inference allowance is economically €0.05 per conversation; the Planet premium is the same rate multiplied by 5,000 conversations: €250/month. The catalog does not currently store a separate per-conversation inference field or bill a metered inference line item. The rate is expressed through the fixed plan price and conversation allowance, so `planet_managed` mirrors that structure at 74,900 cents monthly and 749,000 cents annually.

### Decision

Add `planet_managed` directly after `planet` in catalog order with managed models and every quota/allowance copied from Planet. Give it distinct `planet_managed_month` / `planet_managed_year` lookup keys and make it the self-serve ceiling. Existing generic consumers then provide:

- Stripe checkout lookup-key resolution.
- Product metadata to plan mapping in webhooks.
- Stripe product, prices, portal choices, and drift correction in `stripe:sync`.
- Usage-limit profile seeding at Enterprise boot without a schema migration.
- Managed-model policy resolution from the assigned profile key.

`upgradePlanIdFor` remains catalog ordered: Satellite upgrades to Planet BYOK, Planet upgrades to `planet_managed`, and the managed variant has no further upgrade. The frontend derives the special Planet action from a BYOK current plan followed by a managed upgrade with equal allowances, showing the approved €250/month premium without hard-coding a plan id.

## Enumeration Audit

- The public plan and checkout schemas derive ids from `PLAN_CATALOG.plans`.
- The billing webhook validates product metadata through `findPlan`.
- Usage-limit seeding loops over the catalog and creates missing profiles with `ON CONFLICT DO NOTHING`; no migration is required.
- Staff/operator console tier APIs use string profile keys and list database profiles; the new seeded profile is not rejected by a closed enum.
- Frontend API types intentionally use string ids and render catalog entries generically.
- Plan-card fixtures and Playwright coverage enumerate plans and require an explicit managed variant update.
- Plan catalog's TypeScript `PlanId` union is closed and must add `planet_managed`.
- Plan catalog invariants, billing pricing/webhook/sync tests, and Enterprise usage-limit tests need parity assertions.

## Contracts And Documentation

- Public response shape is unchanged; it gains another catalog row. No OpenAPI generation or SDK snapshot change is required.
- No worker or AMQP payload changes occur. Credential authorization is evaluated at consumption through the existing workspace resolver; queue dispatch, retry semantics, and queue docs remain unchanged.
- Billing checkout remains operator-initiated and is already permanently excluded from the Ray coverage map. The BYOK fix changes Ray availability through its existing resolver probe and adds no operator capability or tool descriptor.
- Documentation changes belong in the plan-catalog README, `ee/readme.md`, billing setup, and Enterprise usage-limit/pricing documentation. Product-docs corpus must be regenerated after MDX edits.

## Observability Review

No new log, metric, audit event, or span is needed. This change closes an authorization branch before provider invocation and reuses the existing structured `provider_misconfigured` error and Ray availability state. The shared resolver already emits content-free capability-selection debug fields, and provider calls retain existing usage/latency telemetry. Logging plan ids or credential-source detail on every call would add noise without improving the operator-visible remediation.

