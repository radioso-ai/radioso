# Implementation Plan: Notification Email Caps And Hygiene

**Branch**: `fix/notification-email-caps-1464` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/1464-notification-email-caps/spec.md`

## Summary

Add an OSS-owned, persistence-backed operator-notification admission guard that gets daily email allowances from the existing usage-limit policy and applies a fixed conversation dispatch cap. Extend the EE plan catalog/policy to resolve per-plan allowances. Harden delivery by classifying mail, bounding visitor content, validating reply-to headers, and signing URL-secret webhooks. Add a dedicated owner/admin recipient-management permission, audit safe recipient deltas, and apply the restriction consistently to HTTP and operator tooling.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24

**Primary Dependencies**: Express, Zod, Kysely, PostgreSQL 16, existing mail/webhook and operator-copilot modules

**Storage**: PostgreSQL outcome rows in the OSS schema; existing EE usage profile assignment and plan catalog

**Testing**: Vitest, Supertest, PostgreSQL integration tests

**Target Platform**: Self-hosted OSS and Enterprise server/worker runtimes

**Project Type**: Monorepo web service with optional Enterprise modules

**Performance Goals**: One short advisory-locked transaction per unique notification action; indexed workspace/day and conversation counts

**Constraints**: No address in logs/metrics/audit, no OSS→EE import, retry-stable decisions, no recipient-confirmation or suppression work

**Scale/Scope**: Contact, approval, hand-off, and completion operator notifications; existing agent and notify-skill authoring surfaces

## Constitution Check

- **Spec-first**: PASS — approved spec and checklist exist before code changes.
- **Backend TDD**: PASS by plan — failing business-behavior tests precede each implementation phase.
- **Stack discipline**: PASS — existing TypeScript/PostgreSQL stack only.
- **Secrets/config**: PASS — no new environment secret; existing configured URL remains the contact-webhook secret.
- **Modularity**: PASS — operator-notification domain owns the guard port/service; DB adapter owns queries; usage policy only resolves plan allowance; composition only wires.
- **Data protection/reliability**: PASS — fail-closed context, hashes instead of addresses, atomic/idempotent decisions.
- **API contracts**: PASS — no payload schema changes. Conditional authorization may add 403 behavior. Message-queue review in research finds no queue contract change.
- **Documentation parity**: PASS by plan — all requested pages and compiled corpus update.
- **Copilot coverage**: PASS — existing tools gain conditional authorization; no new operator capability.

Post-design re-check: PASS. The model and internal contract keep policy resolution, admission, persistence, transport, and authorization concerns in their owning modules.

## Module Knowledge And Dependency Direction

- `operatorNotifications` knows admission semantics and bounded outcomes, not SQL, plans, mail providers, or HTTP roles.
- The delivery-outcome repository knows atomic PostgreSQL counting, not plan selection or transport behavior.
- `UsageLimitPolicy` knows only the resolved daily allowance. EE may import the plan catalog; OSS callers depend only on the shared port.
- Contact/notice transports know whether the guard allows dispatch/email and how to render/send, not how counts are persisted.
- HTTP and operator-tool edges know the caller and conditional permission; services know when persisted recipient values changed and how to audit a safe delta.
- Composition constructs the shared guard from repository, policy, audit, and logger and injects it into handlers.

## Project Structure

```text
backend/src/modules/operatorNotifications/       # delivery admission domain/service
backend/src/db/repositories/                     # PostgreSQL outcome adapter
backend/src/db/migrations/                       # outcome table
backend/src/modules/chat/services/actions/       # contact/notice transport hygiene
backend/src/modules/agents/                      # agent recipient audit
backend/src/modules/agentSkills/                 # notify recipient audit
backend/src/modules/account/                     # dedicated permission
backend/src/modules/operatorCopilot/             # conditional tool/apply authorization
backend/src/app/composition/                     # runtime wiring
ee/packages/plan-catalog/                        # plan allowances
ee/packages/backend-module/src/usageLimits/      # EE allowance resolver
docs-portal/content/ and docs/                   # operator documentation
specs/1464-notification-email-caps/              # feature artifacts
```

**Structure Decision**: Extend existing owners and add one focused repository/service seam. No new workspace package or public endpoint is needed.

## Complexity Tracking

No constitution violations require justification.
