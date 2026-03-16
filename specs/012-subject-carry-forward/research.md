# Research: Conversational Subject Continuity

## Decision 1: Treat subject continuity as retrieval state, not text-only pronoun resolution

**Decision**: Model continuity around a retrieval-owned carried subject that is established and revalidated from grounded retrieval evidence, not from regexes or free-form LLM coreference guesses.

**Rationale**: Current follow-up handling in `QueryRewriteService` depends on `REFERENTIAL_PATTERN` and extraction from the last user message. That is brittle, English-centric, and does not use the stronger signal the system already has: chunk-level subject labels and retrieval outcomes.

**Alternatives considered**:
- Regex-driven pronoun expansion from chat history: rejected because it is multilingual-fragile and already too implicit in the current code.
- LLM-only referent resolution from history: rejected because it invents authoritative subject state from an ungrounded generative step.

## Decision 2: Use dual retrieval paths when the turn is not self-contained

**Decision**: For context-dependent turns, run raw retrieval and subject-biased retrieval, then compare the resulting subject clusters before reusing a carried subject.

**Rationale**: Raw retrieval is the least biased reading of the current turn. Subject-biased retrieval can recover low-content follow-ups, but it can also overfit to stale context. Comparing both paths makes disagreement explicit and testable.

**Alternatives considered**:
- Always use only subject-biased retrieval when a carried subject exists: rejected because it over-indexes on stale memory and hides topic changes.
- Always use only raw retrieval: rejected because low-content or zero-pronoun turns often need the prior grounded subject to recover useful evidence.

## Decision 3: Converge on normalized subject identities, not raw labels

**Decision**: Build convergence and disagreement decisions on normalized subject identities or equivalence classes derived from existing `subjectLabel` values and any available stable ids.

**Rationale**: Raw surface labels are too noisy for multilingual and alias-heavy corpora. Existing `subjectIdentityService` already normalizes identity phrases, which provides a base seam for identity comparison without requiring a full entity platform.

**Alternatives considered**:
- Compare only raw `subjectLabel` strings: rejected because alias and formatting drift would make deterministic rules noisy.
- Require a new dedicated entity database first: rejected because it widens scope beyond the approved v1 feature.

## Decision 4: Make convergence metrics explicit and diagnostic

**Decision**: Define convergence around deterministic metrics such as support count, score mass, winner margin, and raw-vs-biased agreement, and expose those metrics in retrieval diagnostics.

**Rationale**: Without explicit metrics, hidden heuristics will creep into rewrite prompts, rerank glue, or orchestration code. Diagnostics make the decision explainable and testable.

**Alternatives considered**:
- Keep convergence described only as “deterministic rules”: rejected because it is too vague for consistent implementation.
- Log only the final outcome without evidence metrics: rejected because it obscures why a subject was reused or cleared.

## Decision 5: Bound relation shift as a v1 limitation

**Decision**: Acknowledge related-subject focus shifts such as person-to-book or company-to-product as a bounded v1 limitation, provided the system does not silently misclassify them as plain subject reuse.

**Rationale**: Full focus tracking would introduce `activeFocus` or lineage memory and materially widen scope. The approved spec is about subject continuity and revalidation, not general relation-aware conversation memory.

**Alternatives considered**:
- Add `activeFocus` and relation lineage now: rejected because it meaningfully expands scope before implementation starts.
- Ignore relation shift entirely: rejected because at minimum the design needs to avoid silently pretending those shifts are ordinary reuse.
