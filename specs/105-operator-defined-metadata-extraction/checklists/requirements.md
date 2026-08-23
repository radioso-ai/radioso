# Specification Quality Checklist: Operator-Defined Metadata Extraction

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-18
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — architecture constraints section intentionally names seams per repo template; requirements and stories stay behavior-level
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders (stories/requirements); architecture section targets engineering per template
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (owner decisions recorded as pinned decisions 1–5)
- [x] Requirements are testable and unambiguous (two-stage validation contract enumerates unknown/invalid/duplicate/missing field behavior; bounds carry concrete numbers)
- [x] UI tasks captured for user-facing features (catalog editor location, read-only built-ins, validation messages, non-blocking delete/disable warnings — US1 scenarios 7–8)
- [x] Success criteria are measurable (call count, prompt-overhead ceiling, CI fixture list)
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified (key syntax, reserved keys, catalog/output bounds, type deletion, collisions, built-ins contract)
- [x] Scope is clearly bounded (per-source pinning, multi-type tagging, backfill, per-field storage all excluded explicitly)
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification (outside the mandated Architecture Constraints section)

## Notes

- Revision 2 addresses the 2026-08-18 review: field identity (workspace-wide typed
  namespace, immutable keys/value types, rename = delete + create), dot-free key
  syntax, provenance-recorded generated-key ownership and cleanup, concrete
  catalog/prompt/output bounds with save-time enforcement, a five-built-ins
  compatibility contract (`profile`/`reference` stay as field-less built-ins),
  US3 removed to Out of Scope, suggestion source defined as catalog ∪ observed
  keys, the two-stage validation contract, catalog permissions, UI acceptance
  criteria, and eval quality targets.
- Revision 3 addresses the 2026-08-19 review: explicit output wire format
  (`fields` as an ordered `{key, value}` array so duplicates survive parsing;
  `facts` stays exclusive to built-in temporal types), manual edits relinquish
  generated-key ownership in the same write, tag replacement atomic with success
  (failed runs preserve tags and the prior generated-key set), provenance defined
  as current-state only (no per-document history claim), catalog mutations as
  conditional writes on expected revision with a conflict response, execution-time
  catalog resolution decided in-spec, tombstoned field identities barring key
  reuse under a different value type, and OpenAPI + typescript-sdk snapshot
  regeneration called out as in-scope for the plan.
- Owner pre-decided: one LLM call per document; workspace-level catalog; sources
  keep the tri-state enablement; no per-field storage; built-in temporal fast
  path untouched.
- Message-queue impact review is required at plan time; the spec records the
  decision: AMQP message contract unchanged, no catalog data on job payloads,
  catalog resolved at execution time through the read port, provenance records
  the revision actually used.
