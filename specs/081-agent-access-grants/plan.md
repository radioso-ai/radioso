# Implementation Plan: Agent Access Grants (Token Authorization Phase 2)

**Branch**: `081-agent-access-grants` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/081-agent-access-grants/spec.md`

## Summary

Unify the four per-channel credential implementations (website embed, public chat link, agent
REST, agent MCP) behind one first-class **Access Grant** entity bound to an agent. A grant carries
the full credential lifecycle (hashed secret, prefix, rotate, revoke, last-used), an explicit scope
set drawn from the existing `Permission` vocabulary, and an origin constraint (`AllowAll |
Origins[] | empty=allow-none`). The per-workspace admin token (062) stays as the workspace-level
admin tier and remains a superset. The 062 invariant holds: public-launch grants share storage and
lifecycle with API grants but never authenticate on the bearer path. This is Phase 2 of
`062-multiple-role-tokens`, which already shipped the `AuthenticatedPrincipal` model,
`AccountAccessService.requirePermission`, and route permission declarations this plan extends.

## Technical Context

**Language/Version**: TypeScript on Node.js 24
**Primary Dependencies**: Express, Zod, Pino, existing `account`/`auth`/`agents`/`settings` modules; OpenAPI code-first registry
**Storage**: PostgreSQL — new `agent_access_grants` table; existing `workspace_tokens` retained unchanged; existing agent surface JSONB read during migration
**Testing**: Vitest + Supertest (backend contract/integration/unit), Playwright (frontend management UI)
**Target Platform**: Backend API + MCP routes; Next.js settings dashboard
**Project Type**: Web application (backend + frontend), plus `packages/radioso-mcp-server`
**Performance Goals**: No added round-trips beyond a single grant lookup by hash (indexed), matching today's token lookup cost
**Constraints**: Preserve 062 invariants (public-launch never bearer; wrong-workspace denial without enumeration); preserve embed same-origin binding (#609→#612); zero forced re-issuance on upgrade
**Scale/Scope**: All existing workspace API/SDK/MCP clients + every agent with an embed or public-chat token

## Constitution Check

*GATE: must pass before Phase 0; re-check after Phase 1 design.*

- Spec exists; this plan does not authorize implementation until the spec is approved.
- Backend work is TDD: failing contract/unit tests before implementation (role allow/deny, rotate/revoke, origin allow/deny/all/none, public-launch bearer rejection, wrong-agent/workspace denial).
- Frontend management UI (P2) planned for Playwright; any frontend unit tests stay on data/state transforms, not markup.
- Stack stays Node.js + React; DB stays PostgreSQL with `pgvector` (no vector change here).
- LLM provider unchanged; no runtime conversational copy added (FR honors "no hard-coded assistant strings").
- Secrets: grant secrets stored hashed + encrypted, revealed once; no new `.env` required beyond reusing the existing token-secret/key derivation (`WORKSPACE_TOKEN_SECRET`); update `.env.example` only if a new key is introduced.
- Customer data: roles default to the narrowest set; least-privilege is the default for new grants.
- Module boundaries explicit (see Module Ownership). Domain owns grant lifecycle + origin evaluation; middleware attaches principals; repositories own persistence; composition wires replaceable infra.
- Composition: a new `AccessGrantRepository` and `OriginMatcher` are app-wide replaceable infrastructure → wire defaults in `backend/src/app/composition/`. Domain rules stay in `modules/`.
- OpenAPI: agent grant management contracts change HTTP shapes → update `backend/src/app/http/openapi/document.ts` and schemas; treat `backend/openapi.{yaml,json}` as generated.
- Message-queue impact review REQUIRED (public API/SDK/MCP contracts change). Initial read: document-worker dispatch and AMQP payloads do not carry channel tokens, so likely unaffected — the plan MUST verify and record this in research.md before tasks.
- Docs: MCP setup, SDK getting-started/auth, website-embed/crawler, and operator token docs updated in the same feature (062 already touched these; extend, don't duplicate).

## Project Structure

### Documentation (this feature)

```text
specs/081-agent-access-grants/
├── plan.md            # this file
├── research.md        # Phase 0: migration strategy, MQ impact confirmation, secret-hash reuse
├── data-model.md      # Phase 1: agent_access_grants schema + principal extension
├── quickstart.md      # Phase 1: issue → scope → use → rotate → revoke walkthrough
├── contracts/         # Phase 1: grant management + scoped-auth contract shapes
└── tasks.md           # Phase 2 (/speckit.tasks — not produced here)
```

### Source Code (real paths)

```text
backend/src/
├── modules/accessGrants/                      # NEW domain — grant lifecycle + evaluation
│   ├── domain.ts                              #   AccessGrant entity, GrantPrincipalKind, OriginConstraint
│   ├── services/accessGrantService.ts         #   issue/rotate/revoke/touch; scope+origin evaluation
│   ├── originMatcher.ts                        #   AllowAll | Origins[] | empty → boolean (one impl)
│   └── public.ts
├── db/
│   ├── repositories/accessGrantRepository.ts  # NEW — find-by-hash, list-by-agent, save, revoke, touch
│   └── migrations/0xx_agent_access_grants.sql # NEW — table + migration of embed/public tokens
├── modules/account/services/accountAccessService.ts  # EXTEND — agent-scoped principal + grant→permission set
├── app/http/middleware/
│   ├── requireApiToken.ts                     # EXTEND — resolve agent grant principal (bearer lane)
│   ├── resolveAnonymousSession.ts             # EXTEND — origin match via OriginMatcher (public lane)
│   └── requirePermission.ts                   # UNCHANGED seam — scope check flows through 062 path
├── modules/agents/services/agentService.ts    # EXTEND — surface settings reference a grant, not own a token
├── modules/settings/services/platformSettingsService.ts  # EXTEND — channel patch delegates to grants
└── app/http/openapi/                          # EXTEND — grant mgmt + scope schemas; regenerate artifacts

backend/tests/
├── contract/access-grants.contract.test.ts    # scope, rotate/revoke, public-launch bearer rejection
├── integration/access-grant-origin.test.ts     # allow/deny/all/none + embed same-origin binding
└── unit/origin-matcher.test.ts

frontend/components/dashboard/settings/
├── workspace-assistant-channels-tab.tsx        # EXTEND — channel cards reference grants
├── api-channel-card.tsx / mcp-channel-card.tsx  # EXTEND — show grant + scope (P2 mgmt)
└── (new) agent-access-grants-list.*            # P2 — multiple labeled grants per agent

packages/radioso-mcp-server/                     # EXTEND — tool policy keys off grant scope (RD-1)
```

**Structure Decision**: Introduce a focused `modules/accessGrants/` domain that owns lifecycle and
constraint evaluation. Reuse — do not fork — 062's `AccountAccessService`/`requirePermission` for
the actual allow/deny decision; the grant domain *supplies* the principal and its scope set, the
account service *decides*. Persistence is a dedicated repository. Composition wires the repository,
`OriginMatcher`, and scope policy.

## Module Ownership & Seams

- **Transport Layer**: `requireApiToken` / `resolveAnonymousSession` attach the principal (now
  possibly an agent-grant principal); route handlers declare required permission as today and stay
  transport-only — no scope matrices in handlers.
- **Orchestration Layer**: `agentService` and `platformSettingsService` stop owning token strings;
  they delegate to `accessGrantService` for issue/rotate/revoke and read grant references.
- **Domain Layer**: `accessGrantService` owns the grant lifecycle, scope set resolution, and origin
  evaluation via `OriginMatcher`. `accountAccessService` remains the single allow/deny decider.
- **Persistence/Integration Layer**: `accessGrantRepository` owns the `agent_access_grants` table
  and secret-hash lookup; `workspace_tokens` repository stays as-is for the admin tier.
- **Application Composition**: `backend/src/app/composition/` wires `AccessGrantRepository`,
  `OriginMatcher`, and the scope policy as replaceable defaults.
- **Files Kept Small**: `requirePermission.ts` must not regain any bypass (062 rule); route
  handlers must not embed scope matrices; `agentService` must not absorb credential hashing —
  that belongs to `accessGrantService`/repository.
- **Planned Extractions**: `modules/accessGrants/` (domain), `accessGrantRepository` (persistence),
  `OriginMatcher` (port). The public-surface plaintext `token` field on agent surface settings is
  retired in favor of a grant reference.
- **Required Refactor Stories**: Migration story (US1/FR-003) — move existing embed + public-chat
  tokens into grants — MUST land before the public-surface code paths are switched to read grants,
  to keep behavior continuous.

## Phasing (maps to spec user stories)

1. **P1 / US1 — grant substrate + migration**: table, repository, `accessGrantService`, migrate
   existing embed/public tokens; switch read paths. No behavior change visible to clients.
2. **P1 / US2 — role-based authorization**: grant carries a role; capability access is decided by
   `AccountAccessService` role mapping via existing `requirePermission`.
3. **P1 / US3 — origin allow-list**: `OriginMatcher` as the one implementation; embed allow-list
   migrates onto it (with same-origin binding preserved); allow-all + allow-none semantics.
4. **P1 / US4 — bearer-lane invariant**: regression tests that public-launch grants are rejected on
   bearer REST/MCP and accepted only on session-exchange.
5. **P2 / US5 — multi-grant management UI**: labels, enable/disable, independent revoke; Playwright.

## Complexity Tracking

No constitution violations. The single judgment call is adding a new domain module
(`modules/accessGrants/`) rather than extending `auth`/`account`: justified because grant lifecycle
+ constraint evaluation is a distinct responsibility from authentication extraction (auth) and the
allow/deny policy (account), and folding it into either would recreate the god-object smell 062
deliberately avoided.
```
