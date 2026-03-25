# Research: Answer Support Validator

## Decision 1: Use explicit citation anchors as the validator's evidence references

- Decision: Treat normalized `answerSegments` plus their `citationIndices` as the inspectable support-identification data for validation.
- Rationale: The existing chat flow already converts raw model output into deterministic answer segments tied to retrieved contexts. Reusing that seam keeps validation deterministic, cheap, and easy to test, while still enforcing that unsupported substantive text without valid support references is removed before persistence and final delivery.
- Alternatives considered:
  - Run a second LLM judge pass over the answer and contexts. Rejected because it adds cost, latency, nondeterminism, and another failure mode to a safety-critical path.
  - Use prompt wording alone without post-processing. Rejected because the spec explicitly requires enforcement after generation, not best-effort prompt compliance.

## Decision 2: Classify segments into supported, unsupported, or non-substantive

- Decision: Introduce a focused validator that classifies each normalized answer segment as:
  - `supported` when the segment is substantive and carries at least one valid support reference
  - `unsupported` when the segment is substantive and carries no valid support reference
  - `non_substantive` when the segment is low-information conversational text that does not introduce factual or procedural content
- Rationale: This exactly matches the approved spec, supports mixed-answer rewrites, and keeps the policy explainable in persisted diagnostics.
- Alternatives considered:
  - Whole-answer pass/fail validation. Rejected because the spec requires segment-level preservation of supported content.
  - Only distinguish supported vs unsupported. Rejected because low-information conversational wrappers should survive when safe.

## Decision 3: Replace unsupported substantive segments with a fixed explicit notice

- Decision: Replace each unsupported substantive segment with the same explicit end-user notice, and collapse to only that notice when all substantive segments are unsupported.
- Rationale: A fixed notice is easy to recognize in tests, safe to persist, and consistent across JSON and SSE delivery.
- Alternatives considered:
  - Drop unsupported segments silently. Rejected because the user should be able to tell that part of the answer could not be supported.
  - Generate a bespoke explanation for each unsupported segment. Rejected because it reintroduces model-generated variability into the safety path.

## Decision 4: Buffer SSE answer text until validation completes

- Decision: Preserve the existing SSE event types, but do not emit raw model answer chunks when retrieved context exists. Instead, buffer the raw completion, validate the final answer, and then emit only validated text chunks followed by the existing `done` event.
- Rationale: The spec requires post-generation validation before final delivery. Token-by-token streaming of the unvalidated model answer would leak unsupported content before the validator runs.
- Alternatives considered:
  - Keep current incremental streaming and only sanitize the final `done` payload. Rejected because unsupported text would already have been delivered to the user.
  - Disable SSE entirely for grounded answers. Rejected because the existing SSE contract can be preserved with deferred chunk emission.

## Decision 5: Persist degraded answer outcomes in audit metadata, not a new table

- Decision: Record the assistant-turn outcome and validation summary in existing `chat.answer` audit metadata and replay it through chat history debug payloads.
- Rationale: The feature spec calls for degraded persistence and debug visibility, and the current audit/history path already owns assistant-turn diagnostics.
- Alternatives considered:
  - Add message-table columns or a new diagnostics table. Rejected because the current audit-event store is already the source of truth for answer debug metadata and no schema change is required for the approved scope.

## Decision 6: Tighten prompt guidance so substantive claims should be cited claim-by-claim

- Decision: Update `promptBuilder.ts` instructions so the model is told to place a citation anchor immediately after each substantive grounded claim and to omit unsupported claims rather than grouping multiple claims under one citation.
- Rationale: The validator depends on explicit support references, so prompt guidance should increase anchor fidelity without owning the final enforcement decision.
- Alternatives considered:
  - Leave prompt instructions unchanged. Rejected because validation quality would depend on a looser anchor format than this feature now requires.
