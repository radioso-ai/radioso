# Research: Triggered Retrieval Filters

## Decision 1: Store trigger configuration as additive fields on existing retrieval metadata rules

- Decision: Extend the existing retrieval metadata-rule model with optional trigger metadata and bounded date token support instead of creating a separate settings family.
- Rationale: The current retrieval settings persistence already owns rule authoring and serialization through `attribute_controls`, so additive fields preserve compatibility for existing workspaces and keep transport/persistence ownership in the settings modules.
- Alternatives considered:
  - Separate trigger-policy settings collection: rejected because it would split one operator workflow across two settings surfaces and complicate persistence joins.
  - Prompt-only trigger instructions outside structured settings: rejected because it would violate the spec’s auditability and bounded-diagnostics requirements.

## Decision 2: Keep trigger matching inside query interpretation as a structured sub-result

- Decision: Add trigger matching to the query-interpretation path, but represent it as an explicit structured result and dedicated logical trace/eval node.
- Rationale: This satisfies the approved architecture rule that trigger matching remains part of query interpretation in v1 while still making it independently inspectable in retrieval trace, chat history, and eval replay.
- Alternatives considered:
  - New top-level pipeline stage before query interpretation: rejected because it conflicts with the approved spec placement rule.
  - Hide trigger decisions inside rewrite output only: rejected because it would make trace ownership and replay comparison too opaque.

## Decision 3: Structured completion is the sole authoritative v1 trigger classifier

- Decision: Use a model-backed structured completion flow to evaluate free-form trigger instructions against the user query; do not require embeddings for correctness.
- Rationale: The spec requires authoritative completion-based decisions in v1 and allows embeddings only as optional preselection or acceleration. The existing query-rewrite gateway pattern already provides a clean seam for bounded structured model output.
- Alternatives considered:
  - Embeddings-only similarity enactment: rejected because the spec explicitly disallows embeddings as the authoritative enactment mechanism in v1.
  - Product-owned intent enums: rejected because the spec explicitly forbids forcing operator-authored triggers into a fixed intent taxonomy.

## Decision 4: Skip model trigger analysis entirely when no triggerable rules are configured

- Decision: Compute the set of enabled triggerable rules from persisted settings during query interpretation, and short-circuit the trigger matcher when that set is empty.
- Rationale: This is the only way to meet the latency/cost requirement without a hidden no-op model call. The skip state must still be visible in diagnostics as “not configured”.
- Alternatives considered:
  - Always execute the matcher with an empty candidate list: rejected because it still pays the orchestration cost and muddies trace semantics.

## Decision 5: Evaluate `today()` as a bounded dynamic date token at candidate-application time

- Decision: Represent dynamic date comparisons with an explicit token model and resolve `today()` during metadata rule evaluation rather than treating it as a raw stored string.
- Rationale: Date semantics belong with candidate policy application, not settings transport or prompt construction. Execution-time evaluation keeps operators from editing stale saved dates and allows validation of supported value-type/operator combinations.
- Alternatives considered:
  - Expand `today()` in the UI before save: rejected because saved literal dates would become stale immediately.
  - Resolve `today()` during query analysis: rejected because date comparisons are applied against candidate metadata, not query semantics.

## Decision 6: Record trigger matching, enactment, and backoff as first-class diagnostics

- Decision: Extend retrieval diagnostics, retrieval info presentation, retrieval trace assembly, chat-history debug hydration, and eval replay surfaces with structured trigger-analysis data plus any filter backoff event.
- Rationale: The feature’s value depends on trustworthy auditability. Existing retrieval info/trace surfaces are already the durable source for operator-visible diagnostics, so additive fields there preserve current ownership boundaries.
- Alternatives considered:
  - New standalone audit product or dashboard: rejected because the spec requires extending existing history/trace/eval surfaces.

## Decision 7: Trigger-enacted hard filters must support explicit backoff

- Decision: Let candidate preparation apply matched rules first, then relax trigger-enacted hard filters when they produce weak or empty support, recording the backoff in applied constraints and trigger diagnostics.
- Rationale: This satisfies the safe-fallback requirement while keeping candidate-preparation as the owner of policy enactment and candidate fallback decisions.
- Alternatives considered:
  - Fail closed once a hard filter matches: rejected because it would violate FR-009 and create brittle behavior for narrowly filtered workspaces.
  - Back off silently: rejected because it would undermine replay/debug trust.

## Decision 8: Improve retrieval settings authoring by explaining policy mode and common date-trigger behavior inline

- Decision: Refresh the retrieval settings UI around rule cards that explicitly distinguish always-on vs trigger-based behavior, explain boost vs filter effects in plain operator language, and make `today()` discoverable for supported date comparisons.
- Rationale: The current retrieval settings panel already owns rule authoring. Improving that surface keeps UX changes within existing admin patterns and avoids a scope-expanding redesign.
- Alternatives considered:
  - Minimal extra textarea field only: rejected because the approved spec requires broader clarity/convenience improvements.
  - New separate trigger builder screen: rejected as unnecessary scope expansion beyond the approved settings surface.
