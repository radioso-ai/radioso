# Implementation Plan: Planet Managed Models

**Branch**: `feat/planet-managed-models-1421` | **Date**: 2026-10-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/1421-planet-managed-models/spec.md`

## Summary

Close the BYOK credential leak at the shared workspace capability resolver by making the Enterprise model policy explicitly authorize or deny platform credentials for every text and embedding capability. Then add `planet_managed` as a first-class catalog plan, relying on existing catalog-derived policy, usage-limit, checkout, webhook, Stripe-sync, and operator-console behavior, with a clear Planet model choice in the billing UI.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 / Next.js 16

**Primary Dependencies**: Existing LLM provider registry, Enterprise plan catalog and billing module, Stripe adapter, shared dashboard UI

**Storage**: Existing PostgreSQL Enterprise usage-limit profiles; no schema migration

**Testing**: Vitest, Supertest, Playwright

**Target Platform**: Radioso Cloud Enterprise API, worker, dashboard, and Stripe deployment tooling; OSS self-host behavior preserved

**Project Type**: Monorepo web application with optional Enterprise modules

**Performance Goals**: One Enterprise plan lookup per capability resolution; no extra provider calls or billing branches

**Constraints**: Two ordered commits; no live Stripe mutation; no secret output; no hard-coded conversational assistant copy; keep existing public API shapes

**Scale/Scope**: All workspace-scoped LLM/embedding consumers, four catalog plans, two new Stripe prices, one visible billing choice

## Constitution Check

- **Spec-first**: PASS — this approved spec and plan precede production code.
- **Backend TDD**: PASS by plan — failing resolver and Enterprise-policy behavior tests precede the credential fix; failing catalog/billing tests precede the priced variant.
- **Stack discipline**: PASS — existing TypeScript, React, and PostgreSQL only.
- **Secrets/config**: PASS — no new secrets or environment variables; test Stripe sync only when an existing test key is available.
- **Modularity**: PASS — catalog owns commercial facts; Enterprise policy translates plan facts into a narrow decision; the shared resolver owns credential precedence; provider consumers remain policy-blind.
- **Data protection/reliability**: PASS — BYOK fails closed before platform credentials are read; no credential values enter diagnostics.
- **API contracts**: PASS — response schemas remain catalog-derived/open strings and gain data only. Queue review found no payload or retry change.
- **Documentation parity**: PASS by plan — catalog/Enterprise/operator pricing docs and compiled product corpus update.
- **Prompt ownership**: PASS — no prompt change.
- **Frontend testing**: PASS — visible Planet selection gets Playwright coverage; no CSS/layout unit tests.
- **Copilot coverage**: PASS — billing checkout retains its documented permanent exclusion; Ray's existing availability probe consumes the corrected resolver and no new tool is added.

Post-design re-check: PASS. One policy decision preserves dependency direction and prevents repeated plan reads.

## Module Knowledge, Ports, And Dependency Direction

- `plan-catalog` knows plan ids, prices, quotas, model mode, and Stripe lookup keys. It does not know accounts, credentials, provider clients, UI state, or Stripe SDK objects.
- `EnterpriseManagedModelPolicy` knows how a workspace resolves to a catalog plan and translates that into `managedModel` plus platform-credential permission. It does not decrypt credentials or construct clients.
- `ManagedModelPolicy` is the narrow cross-module port consumed by composition. The shared resolver sees only the policy decision, never Enterprise plans or accounts.
- `WorkspaceLlmCapabilityResolver` knows precedence among agent/workspace/default model selection and workspace/platform credential sources. It does not know plan ids, prices, or billing state.
- Provider registries/gateways and chat, Ray, retrieval, document, summary, and suggestion consumers depend inward on the resolver/gateway ports; they never import Enterprise or catalog code.
- Billing and Stripe sync depend on catalog entries. The UI consumes the existing plan/billing API and computes display wording from current/upgrade plan facts rather than adding a second commercial source of truth.
- Composition remains assembly-only: it registers the Enterprise policy and injects the resolver; product rules stay in the catalog, policy, resolver, and frontend presentation owner.

## Project Structure

```text
backend/src/shared/domain/managedModelPolicy.ts                 # shared policy decision port
backend/src/app/composition/workspaceLlmCapabilityResolver.ts  # credential enforcement
backend/tests/unit/                                             # resolver regression tests
ee/packages/backend-module/src/managedModels/                  # catalog-to-policy adapter
ee/packages/plan-catalog/                                      # Planet variant and invariants
ee/packages/backend-module/src/billing/                        # generic mapping/sync tests
frontend/components/dashboard/plan-card.tsx                    # visible Planet model choice
frontend/tests/e2e/plan-card.spec.ts                            # user journey
docs-portal/content/operators/                                 # billing deployment docs
docs-portal/content/operators/enterprise-usage-limits.mdx      # plan/pricing behavior
ee/readme.md                                                    # Enterprise plan summary
specs/1421-planet-managed-models/                              # approved delivery artifacts
```

**Structure Decision**: Extend existing owners only. No package, endpoint, database migration, queue contract, or new billing code path is required.

## Complexity Tracking

No constitution violations require justification.

