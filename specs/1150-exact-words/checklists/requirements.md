# Specification Quality Checklist: Exact Words

**Purpose**: Validate specification completeness and quality before product review and planning.
**Created**: 2026-09-14
**Feature**: [Exact Words specification](../spec.md)
**Review Ownership**: Requirements-quality review maintained by speckit-specify; checked items do not indicate implementation completion or user approval.

## Content Quality

- [x] No implementation design leaks into user scenarios, functional requirements, or success criteria; mandated constitution and architectural boundaries are explicitly separated.
- [x] Focused on operator control, visitor experience, and trustworthy published wording.
- [x] Product behavior is understandable without knowledge of implementation internals.
- [x] All mandatory sections from the resolved repository template are complete.

## Requirement Completeness

- [x] No unresolved clarification markers remain; proposed scope and defaults are explicit assumptions.
- [x] Requirements are testable and unambiguous.
- [x] Success criteria are measurable.
- [x] Success criteria describe observable outcomes without prescribing implementation technology.
- [x] Acceptance scenarios cover each primary user story.
- [x] Edge cases include multilingual fallback, slot references, directive precedence, stream emission, failed-reply re-entry, handoff, and publishing.
- [x] Scope excludes directive authoring, reusable response libraries, proactive sends, mixed composition, translation generation, a separate variable-declaration layer, a pending-reply/retry lifecycle, and a label-versus-submitted-text chip split.
- [x] Dependencies and assumptions are identified.

## Feature Readiness

- [x] Functional requirements have clear acceptance criteria across the scenarios, edge cases, and explicit pass/fail rules.
- [x] User scenarios cover greeting authoring, routine replies, localization, chips, preview, Ray, and publication inspection.
- [x] Measurable outcomes cover exactness, validation failure, locale resolution, normal chip handling, revisions, replay, and compatibility.
- [x] Implementation mechanisms remain planning decisions within the required boundary constraints.

## Notes

- Status: requirements review complete; the feature specification remains **Draft**, not approved for planning or implementation.
- The repository template mandates Constitution Constraints and Architecture Constraints. Those sections intentionally identify existing boundaries, governance, observability, and contract obligations; they are not an implementation plan.
- An independent first review found six areas needing precision: saved-draft validity, locale/default precedence, variable use across translations, routine failure/retry state, existing directive obligations, and atomic revision selection. The spec now states explicit behavior for each.
- A second independent review of the revised requirements passed with no remaining contradictions among the reviewed changes.
- A third review (2026-09-14) checked the draft against current code and amended it: (1) dropped the pending-reply/explicit-retry lifecycle — failed exact routine replies now fail the turn and leave the routine on its step under existing runner semantics (FR-011); (2) dropped the variable declaration/binding layer in favor of the existing `{{slot.<key>}}` and context-variable references, with slot types supplying the format (FR-006); (3) dropped the chip label-versus-submitted-message split — the existing suggestion contract carries one `text` — and named the real contract change (stable chip id, bootstrap suggestions) explicitly (FR-008); (4) collapsed two default-language knobs into one: the agent default locale is the mandatory variant and the final fallback (FR-005); (5) put approval-step prompts in scope with their option chips untouched (FR-001); (6) merged FR-003/005/013 into one guarantee and renumbered; (7) added delivery slices and a planning-verification list to Assumptions.
- Product decisions to review: greeting/routine-first scope; whole-message exactness; exact wording takes precedence over matched directives' answer wording with explicit non-rendered accounting; manual translations keyed to the agent default locale; valid complete saves; no generated fallback and no retry lifecycle for failed exact content; chips submit their label; approval prompts in scope; two delivery slices; proposed content limits.
- Validation covers document structure, unique requirement/outcome identifiers, unresolved placeholders, whitespace, and requirements consistency. No application tests were run because this change adds specification artifacts only.
