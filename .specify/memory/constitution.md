<!--
Sync Impact Report
- Version change: 1.2.0 to 1.3.0
- Modified principles: none
- Added sections: VI. Modularity and Encapsulation
- Removed sections: none
- Templates requiring updates: `.specify/templates/spec-template.md`, `.specify/templates/plan-template.md`, `.specify/templates/tasks-template.md`, `.specify/templates/constitution-template.md`
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
before feature development continues in that area.

### VII. Customer Data Protection and Reliability
The system handles SME customer data. It MUST minimize data collection, enforce
least-privilege access, transmit data securely, and provide clear audit trails
for access to sensitive data. User-facing flows MUST fail safely and degrade
predictably when dependencies are unavailable.

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
- PR review MUST verify compliance with these principles before merge.

## Governance

This constitution supersedes all other guidelines. Amendments require:

- Updating `.specify/memory/constitution.md` with a Sync Impact Report.
- Updating affected templates or guidance files.
- Bumping the constitution version using semantic versioning.

Compliance is enforced during plan/spec/task reviews and PR reviews. The
constitution version, ratification date, and last amended date MUST be updated
whenever changes are made.

**Version**: 1.3.0 | **Ratified**: 2026-02-15 | **Last Amended**: 2026-03-09
