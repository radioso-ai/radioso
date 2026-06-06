---
description: "Task list for Agent Access Grants (Token Authorization Phase 2)"
---

# Tasks: Agent Access Grants (Token Authorization Phase 2)

**Input**: Design documents from `/specs/081-agent-access-grants/`
**Prerequisites**: plan.md ✅, spec.md ✅ (Approved 2026-06-06). research.md / data-model.md / contracts/ produced inline within the tasks below.

**Tests**: Backend tests are REQUIRED and MUST be written failing before implementation. Frontend management UI (US5) uses Playwright for visible behavior; frontend unit tests only for non-visual data/state.

**Architecture**: Preserve `plan.md` module ownership. New domain `modules/accessGrants/` owns lifecycle + constraint evaluation; `accountAccessService` stays the sole allow/deny decider; composition wires the repository and `OriginMatcher`. Do NOT reintroduce any bearer bypass in `requirePermission.ts` (062 invariant).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1–US5 traceability

---

## Phase 1: Setup

- [ ] T001 Confirm working branch (`unify-channel-access-settings`, even with `origin/main`); ensure `pnpm install` clean from repo root.
- [ ] T002 [P] Write `specs/081-agent-access-grants/research.md`: (a) migration strategy for existing embed/public-chat tokens → grants, (b) **message-queue impact review** confirming document-worker dispatch / AMQP payloads carry no channel tokens (record the verification), (c) reuse of `WORKSPACE_TOKEN_SECRET`-derived hashing/encryption from `workspaceTokenRepository`.
- [ ] T003 [P] Write `specs/081-agent-access-grants/data-model.md`: `agent_access_grants` columns, indexes (hash unique, agent_id), and the role-based public principal authorization shape.

---

## Phase 2: Foundational (BLOCKS all stories)

**⚠️ No user-story work begins until this is complete.**

- [ ] T004 [US1] Migration `backend/src/db/migrations/0xx_agent_access_grants.sql`: table with `id, agent_id, workspace_id, label, principal_kind, role, token_prefix, token_hash, encrypted_token, origin_mode, origin_allowlist (text[]), enabled, expires_at, created_at, last_used_at, revoked_at`; unique index on `token_hash`, index on `agent_id`. Idempotent / DDL-lock-aware per `project_migration_startup_ddl_lock`.
- [ ] T005 [P] [US1] `backend/src/modules/accessGrants/domain.ts`: `AccessGrant` entity, `GrantPrincipalKind = 'workspace-admin' | 'agent-api' | 'public-launch'`, `role = 'public'` for public launch grants, `OriginConstraint = { mode: 'allow-all' | 'list'; origins: string[] }`, no permission array.
- [ ] T006 [US1] `backend/src/db/repositories/accessGrantRepository.ts` + port: `findByTokenHash`, `listByAgent`, `save`, `rotate`, `revoke`, `touch`. Mirror hashing/encryption from `workspaceTokenRepository.ts`; secret hashed, never stored plaintext.
- [ ] T007 [US1] `backend/src/modules/accessGrants/services/accessGrantService.ts`: issue/rotate/revoke/touch + `evaluate(grant, { origin })`. No HTTP imports and no permission decisions.
- [ ] T008 [P] [US1] `backend/src/modules/accessGrants/originMatcher.ts`: `AllowAll | Origins[] | empty=allow-none` → boolean. Single implementation. (Unit-tested in T009.)
- [ ] T009 [P] [US1] `backend/tests/unit/origin-matcher.test.ts` (FAILING first): allow-all admits any; list admits exact match only; empty list rejects all; case/trailing-slash normalization matches `shared/domain/websiteEmbed.ts`.
- [ ] T010 [US2] Add the `public` role to `backend/src/modules/account/services/accountAccessService.ts`; map it to the existing `PUBLIC_CHAT_PERMISSIONS` source of truth. Do NOT fork `requirePermission`.
- [ ] T011 [US1] Wire defaults in `backend/src/app/composition/`: `AccessGrantRepository`, `OriginMatcher`.

**Checkpoint**: substrate exists; no client-visible change yet.

---

## Phase 3: User Story 1 — One credential model + migration (P1) 🎯 MVP

**Goal**: Embed/public-chat tokens become grants with full lifecycle (rotate/revoke/last-used); zero forced re-issuance.
**Independent Test**: rotate/revoke an embed grant; last-used advances on success; pre-existing tokens still work post-migration.

### Tests (write FAILING first)
- [ ] T012 [P] [US1] `backend/tests/contract/access-grants.contract.test.ts`: issue→use→rotate(old rejected)→revoke(rejected, not re-minted)→last-used advances.
- [ ] T013 [P] [US1] `backend/tests/integration/access-grant-migration.test.ts`: existing `websiteEmbed.token` / `anonymousChat.token` resolve as grants after migration with no access loss.

### Implementation
- [ ] T014 [US1] Lazy migration (NO SQL backfill): existing `agent.surfaceSettings.{websiteEmbed,anonymousChat}.token` values keep working via the read-path fallback and are migrated into properly-encrypted `public-launch` grants by `AgentService.syncPublicLaunchGrant` on the next agent create/update (preserving embed `allowedOrigins` → `origin_allowlist`). Rationale: a SQL migration lacks `WORKSPACE_TOKEN_SECRET`, so an eager backfill could only store an empty `encrypted_token`; lazy app-layer migration avoids that and touches no agent rows at deploy time. Migration `077` is DDL-only.
- [ ] T015 [US1] Switch public-surface read paths in `backend/src/app/http/middleware/resolveAnonymousSession.ts` to resolve the grant (origin via `OriginMatcher`), preserving #609→#612 same-origin binding (`project_embed_widget_same_origin`).
- [ ] T016 [US1] `backend/src/modules/agents/services/agentService.ts` + `platformSettingsService.ts`: rotate/revoke delegate to `accessGrantService` (DONE via `syncPublicLaunchGrant`). **REVISED after investigation — do NOT do the full "remove plaintext token from surfaceSettings" refactor:** the embed/public-launch token is a *public URL identifier* (it appears verbatim in the embed `<script>` snippet served to every visitor and in the public-chat link), not a confidential secret. It is read by ~15 sites — public-session matching (`publicSessionMatchesAgentSurface`), URL/snippet builders, the settings presenter (`websiteEmbedToken`/`anonymousChatUrl`), rotation, persistence, and frontend display. Removing it is a large, high-coupling change with weak payoff (no confidentiality gain; the grant's `token_hash` is the security artifact, and `surfaceSettings.token` is the display/URL cache kept in sync by `syncPublicLaunchGrant`).
- [ ] T016b [export/079] The real declarative-export requirement is **reference re-binding, not field removal**: on EXPORT, omit the public-launch token + grant; on IMPORT, create the agent without a token so `withRotatedTokens`/`create` mints a fresh one and `syncPublicLaunchGrant` derives a fresh grant. This is small and lives in the export/import code (spec 079), not in this feature. The only secret that must never be exported is `encrypted_token`/`token_hash` (already isolated in `agent_access_grants`, never in the agent config document).
- [ ] T017 [US1] Audit + observability: emit grant issue/rotate/revoke events; auth-failure signal distinguishing revoked/permission-denied/origin-denied — no secret material logged.

**Checkpoint**: US1 functional; behavior unchanged for existing clients.

---

## Phase 4: User Story 2 — Role-based authorization (P1)

**Goal**: Each grant authorizes by role through `AccountAccessService`, not by route reached or a grant-local permission array.
**Independent Test**: a public-role grant is allowed exactly the existing public-chat permissions and denied document-write/settings-manage; admin token still satisfies all.

### Tests (FAILING first)
- [ ] T018 [P] [US2] `backend/tests/unit/account-access-service.test.ts`: public role allows `PUBLIC_CHAT_PERMISSIONS`, denies non-public permissions; admin token superset unaffected.
- [ ] T019 [P] [US2] `packages/radioso-mcp-server/tests/policy.test.ts` extension: role-based MCP grant policy allows read tools for read roles and refuses write tools for roles without write access (RD-1).

### Implementation
- [ ] T020 [US2] `requireApiToken.ts`: resolve an `agent-api` grant into a role-bearing principal on the bearer lane.
- [ ] T021 [US2] Route permission declarations: ensure agent-facing capabilities (`workspace.chat.use`, `workspace.retrieval.query`) accept the agent-grant principal via `requirePermission`; management capabilities remain admin-only.
- [ ] T022 [US2] MCP server tool policy keys off role (RD-1): management tools require admin role, agent tools require the grant's role to allow the requested permission.
- [ ] T023 [US2] Enforce nullable `expires_at` at validation (RD-2): expired grant → denied; null → no expiry.

**Checkpoint**: role-based authorization end-to-end; MCP grant roles work.

---

## Phase 5: User Story 3 — Unified origin allow-list (P1)

**Goal**: One origin model on every browser-reachable surface, with allow-all + allow-none.
**Independent Test**: matching origin admitted, non-matching rejected, allow-all admits any, empty rejects all; embed same-origin binding preserved.

### Tests (FAILING first)
- [ ] T024 [P] [US3] `backend/tests/integration/access-grant-origin.test.ts`: list allow/deny, allow-all, allow-none, and embed-omits-Origin → bound-session-origin path.

### Implementation
- [ ] T025 [US3] Route embed allow-list config through the grant's `OriginConstraint`; surface allow-all vs explicit list vs empty in the settings patch (`platformSettingsService.ts`).
- [ ] T026 [US3] Frontend embed settings: expose allow-all toggle vs origin list; non-visual transform unit-tested, visible journey deferred to US5 Playwright.

**Checkpoint**: origin model unified and consistent.

---

## Phase 6: User Story 4 — Public-launch stays out of bearer path (P1)

**Goal**: Restate and regression-lock the 062 invariant under the unified model.
**Independent Test**: a `public-launch` grant as `Authorization: Bearer` on REST/MCP fails; still valid on session-exchange.

### Tests (FAILING first)
- [ ] T027 [P] [US4] `backend/tests/contract/public-launch-bearer-rejection.test.ts`: public-launch grant rejected on bearer REST + MCP; accepted on session-exchange; wrong-agent/wrong-workspace denied without enumeration.

### Implementation
- [ ] T028 [US4] Enforce principal-kind gate: `requireApiToken` accepts only `workspace-admin`/`agent-api` kinds on the bearer lane; `public-launch` resolves only in `resolveAnonymousSession`.

**Checkpoint**: invariant locked by regression tests (SC-003).

---

## Phase 7: User Story 5 — Multiple grants per agent + management UI (P2)

**Goal**: Issue labeled grants per surface; enable/disable; independent revoke.
**Independent Test**: two labeled grants on one agent; disable one (rejected) while the other works; revoke one without affecting the other.

### Tests
- [ ] T029 [P] [US5] `backend/tests/contract/multi-grant-management.test.ts`: list-by-agent, label, enable/disable, independent revoke; secret shown once at issuance.
- [ ] T030 [P] [US5] Playwright in `frontend/`: operator issues a grant, sees label + last-used, disables one, revokes another — visible journey only.

### Implementation
- [ ] T030b [US5] **REVIEW FINDING #2:** `AgentService.syncPublicLaunchGrant` currently calls `updateGrantConstraints({ enabled: true })` on every agent save, which would silently re-enable a deliberately-disabled grant. Before shipping enable/disable, make the sync NOT flip `enabled` for an operator-disabled grant (only manage origin/label; respect the disabled state).
- [ ] T031 [US5] Management endpoints + OpenAPI schemas (`backend/src/app/http/openapi/document.ts` + schemas); regenerate `openapi.{yaml,json}`.
- [ ] T032 [US5] Frontend `agent-access-grants-list` component; wire `workspace-assistant-channels-tab.tsx`, `api-channel-card.tsx`, `mcp-channel-card.tsx` to show grants + scope; reuse Radix/shadcn.

**Checkpoint**: productized multi-grant management.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T033 [P] Docs: MCP setup, SDK auth/getting-started, website-embed/crawler, operator token docs — describe grants, roles, allow-list (follow `docs/document-writer-prompt.md`). Extend 062's doc updates, don't duplicate.
- [ ] T034 [P] SDK (`typescript-sdk`): `pnpm run sync` + build + tests against regenerated OpenAPI.
- [ ] T035 Run `pnpm run ci:local -- origin/main` (use `--all` given breadth); record result for PR body. Verify any failures against clean `origin/main` per `project_ci_latent_main_breakages`.
- [ ] T036 Validate `quickstart.md` walkthrough end-to-end.

---

## Dependencies & Execution Order

- **Phase 1 Setup** → **Phase 2 Foundational** (BLOCKS everything; T004–T011) → user stories.
- **US1 (Phase 3)** is the MVP and its migration (T014) MUST land before public-surface read paths switch (T015–T016).
- **US2/US3/US4** can proceed in parallel after Foundational; all reuse the US1 grant substrate.
- **US5 (P2)** depends on US1 substrate; can overlap US2–US4.
- **Polish (Phase 8)** after desired stories complete.

### TDD gate
- Every backend implementation task is preceded by its failing test task. MCP/SDK/OpenAPI contract changes carry the message-queue impact review (T002) and doc updates (T033).

## Delivery note

Per the team workflow, implementation is delegated to Codex CLI agents in worktrees, one user story per agent where independence allows, with independent verification (never trusting self-reports) before merge. US1 substrate lands first and solo (it is the shared foundation); US2–US5 can fan out once Foundational + US1 are green.
