<!--
Sync Impact Report
- Version change: 1.8.0 to 1.8.1
- Modified principles: VIII. Code-First API Contracts; IX. Documentation Parity
- Added sections: none
- Removed sections: none
- Templates requiring updates: `.specify/templates/plan-template.md` ✅ updated; `.specify/templates/tasks-template.md` ✅ updated; `.codex/prompts/speckit.plan.md` ✅ updated; `.codex/prompts/speckit.tasks.md` ✅ updated; `.codex/prompts/speckit.implement.md` ✅ updated; `AGENTS.md` ✅ updated
- Follow-up TODOs: none
-->
# Botobot Front Desk AI Constitution

## Core Principles

### I. Spec-First Delivery (NON-NEGOTIABLE)
No implementation work may begin without an approved feature specification in
`/specs/[###-feature-name]/spec.md`. Every implementation task MUST trace back to
a requirement or user story in the spec. If a spec is missing, create it first.

### II. Backend TDD (NON-NEGOTIABLE)
All backend changes MUST follow TDD: write tests first, ensure they fail, then
implement. Backend code is not acceptable without corresponding tests that
demonstrate the intended behavior.

### III. Stack Discipline
Backend services MUST be implemented in Node.js. Frontend experiences MUST be
implemented in React. The primary database MUST be PostgreSQL with the
`pgvector` extension for embeddings and vector search. LLM integrations MUST use
GPT-5.2 as the default provider. Deviations require a constitution amendment.

### IV. Secrets and Configuration Hygiene
All API keys, credentials, and secrets MUST live in `.env` files and MUST NOT be
committed. Every change that introduces new configuration MUST update
`.env.example` and keep `.env` in `.gitignore`.

### V. UI Consistency
All admin-facing pages (login, registration, bot management, admin console) MUST
use the shared dark theme defined in the global CSS variables. New pages and
features MUST reuse the existing design tokens (colors, typography, spacing,
border radii, shadows) rather than introducing custom styles. Deviations from the
established visual language require a constitution amendment.

### VI. Modularity and Encapsulation
Features MUST preserve clear boundaries between transport, orchestration, domain
logic, and persistence. New behavior SHOULD be implemented in focused modules
with explicit responsibilities instead of expanding existing god files or
cross-layer utilities. Plans and tasks MUST identify the owning modules,
expected seams, and any files that must remain orchestration-only or otherwise
responsibility-limited. If discovery shows that code structure is unclear or an
existing file is already too large to safely absorb more behavior, the work MUST
add explicit architecture/refactor stories and tasks to restore clear ownership
before feature development continues in that area. Backend features that add or
replace application-wide adapters, registries, sinks, lifecycle hooks,
capability policies, storage or dispatcher implementations, or other
cross-module runtime infrastructure MUST evaluate whether
`backend/src/app/composition/` should own the default wiring. Composition code
MUST assemble implementations and lifecycle, while domain rules remain in
`backend/src/modules/` or `backend/src/shared/domain/`.

### VII. Customer Data Protection and Reliability
The system handles SME customer data. It MUST minimize data collection, enforce
least-privilege access, transmit data securely, and provide clear audit trails
for access to sensitive data. User-facing flows MUST fail safely and degrade
predictably when dependencies are unavailable.

### VIII. Code-First API Contracts
Backend HTTP contract changes MUST be defined in the code-first OpenAPI registry
at `backend/src/app/http/openapi/document.ts`, using the same Zod-backed request
and response schemas that govern runtime behavior where practical. The checked-in
`backend/openapi.yaml` and `backend/openapi.json` files are generated artifacts
and MUST NOT be hand-edited. Any feature that changes routes, auth, payloads,
status codes, or error shapes MUST regenerate the OpenAPI outputs and keep
contract tests aligned with the generated spec. Any change to public APIs, SDK
contracts, MCP contracts, connector contracts, worker payloads, or other
cross-service contracts MUST include a message-queue impact review that states
whether document worker dispatch, AMQP queue payloads, retry semantics, or queue
contract tests and docs need updates.

### IX. Documentation Parity
Any change to public contracts, operator-facing settings, documented workflows,
or user-visible functionality MUST update the corresponding documentation in the
same change. This includes API contract docs, setup or run instructions,
settings explanations, and any repo-level docs that describe the affected
behavior. Plans and tasks MUST identify the docs that need updates whenever
contract or functionality changes are in scope, including queue/message
documentation when the message-queue impact review finds affected behavior.

### X. Prompt Asset Ownership
Backend runtime LLM prompt templates MUST live under `backend/prompts/`. If a
feature introduces, extracts, or revises model-facing prompt assets used by the
backend at runtime, the spec, plan, tasks, and implementation MUST treat
`backend/prompts/` as the canonical location. 

### XI. Frontend Testing Discipline
Frontend work MUST prefer Playwright coverage for user-visible behavior, flows,
and presentation-sensitive regressions. Frontend unit tests MUST be limited to
non-visual functionality such as state transitions, data transforms, routing
logic, API adapters, and parsing helpers. Unit tests MUST NOT lock in markup
structure, class names, design-token choices, or other cosmetic output that is
better validated through end-to-end coverage.

## Additional Constraints

No additional constraints beyond the Core Principles at this time.

## Development Workflow

- Specs are mandatory gates. Implementation, planning, and tasking MUST stop if
  a spec is missing or unapproved.
- Backend development follows red-green-refactor with tests authored before
  implementation.
- Each feature MUST include a constitution check in plan.md and confirm that
  stack, TDD, secret-management rules, and modular boundary expectations are
  satisfied.
- Backend features that touch replaceable runtime infrastructure MUST state
  whether `backend/src/app/composition/` needs updates and must keep product
  rules out of composition wiring.
- Backend API changes MUST update the code-first OpenAPI registry and regenerate
  `backend/openapi.yaml` / `backend/openapi.json` rather than editing those
  generated files directly.
- Contract changes MUST include a message-queue impact review covering document
  worker dispatch, AMQP queue payloads, retry semantics, queue tests, and queue
  docs.
- Contract and functionality changes MUST identify and update the affected docs
  in the same feature work.
- Backend runtime prompt extraction or creation MUST use `backend/prompts/` and
  keep code, packaging, and tests aligned with that location.
- Frontend planning and review MUST justify any new unit tests for UI code and
  prefer Playwright whenever the behavior is primarily user-visible.
- PR review MUST verify compliance with these principles before merge.

## Governance

This constitution supersedes all other guidelines. Amendments require:

- Updating `.specify/memory/constitution.md` with a Sync Impact Report.
- Updating affected templates or guidance files.
- Bumping the constitution version using semantic versioning.

Compliance is enforced during plan/spec/task reviews and PR reviews. The
constitution version, ratification date, and last amended date MUST be updated
whenever changes are made.

**Version**: 1.8.1 | **Ratified**: 2026-02-15 | **Last Amended**: 2026-05-03
