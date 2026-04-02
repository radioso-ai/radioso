# Research: Eval Regression Lab

## Decision: Reuse the existing chat and retrieval execution path for replay

**Rationale**: Radioso already has the right execution seams for replay: chat orchestration, retrieval traces, answer-support validation, and history/audit metadata. Reusing those paths keeps eval outcomes faithful to production behavior and avoids a second retrieval engine that would drift from the real product.

**Alternatives considered**:
- Build a separate eval-only retrieval executor: rejected because it would duplicate retrieval logic and create false confidence when eval behavior diverges from real chat behavior.
- Replay only retrieval stages without generating an answer: rejected because refusal behavior, support-policy outcomes, and final answer handling are part of the regressions the user wants to catch.

## Decision: Make deterministic product-specific scoring the MVP

**Rationale**: The highest-value Radioso regressions are concrete and inspectable: wrong document, lost citation, incorrect refusal, changed answer-support outcome, or degraded retrieval stage behavior. Those can be scored deterministically and explained clearly.

**Alternatives considered**:
- Start with an LLM-judge score for every case: rejected because it would be opaque, noisy, and weak for regression attribution.
- Require exact final-answer matching: rejected because harmless wording drift would create noise and discourage adoption.

## Decision: Import existing conversations as a first-class dataset creation flow

**Rationale**: The best eval cases usually come from real conversations that exposed a regression or a valuable success. Importing those cases directly from chat history is much higher leverage than asking operators to recreate them manually from memory.

**Alternatives considered**:
- Manual case authoring only: rejected because it is slower, more brittle, and loses important context from the original conversation.
- Bulk-import every conversation automatically: rejected because most history is not durable eval material and can include noise or sensitive content.

## Decision: Preserve bounded prior conversation context per case rather than whole-conversation replay by default

**Rationale**: Retrieval regressions often depend on referential follow-ups and continuity, but replaying an entire long conversation by default would make cases noisy, harder to redact, and more expensive to maintain. The import flow should preserve the relevant context window, not the full chat transcript unless explicitly needed.

**Alternatives considered**:
- Final-turn-only replay: rejected because it would miss regressions tied to follow-up context and rewrite continuity.
- Full conversation capture always: rejected because it increases noise, privacy risk, and maintenance cost for little added value in many cases.

## Decision: Seed expectations from stored retrieval trace and validation diagnostics when available

**Rationale**: Existing traces and validation metadata already encode useful expectations: cited sources, fallback/refusal behavior, answer-support policy outcomes, and retrieval-stage behavior. Seeding from those artifacts reduces manual case setup and makes import practical.

**Alternatives considered**:
- Force operators to enter every expectation manually after import: rejected because it makes the import flow slow and error-prone.
- Freeze the full assistant answer as the default gold artifact: rejected because it overfits to wording and weakens the suite.

## Decision: Treat exact-answer matching as optional and narrow

**Rationale**: Radioso’s product quality is primarily about retrieval, grounding, and refusal correctness. Exact-text matching is appropriate only for narrow cases where wording itself is part of the requirement. Making it universal would create too much churn.

**Alternatives considered**:
- Exact text for all imported turns: rejected because normal model phrasing changes would trigger false regressions.
- No answer-level checks at all: rejected because a minority of cases do need stronger assertions than retrieval-only checks.

## Decision: Persist eval datasets and runs in PostgreSQL, but keep run diagnostics bounded

**Rationale**: Datasets and runs are durable workspace artifacts and fit the existing PostgreSQL application model. The stored run payload should be bounded and replay-oriented, not a warehouse of raw prompts, raw logs, or full document bodies.

**Alternatives considered**:
- Persist only flat files in `specs/` or on disk: rejected because operators need in-product dataset management and run history.
- Store unrestricted run payloads and full model traces: rejected because it creates privacy, storage, and maintainability problems without being necessary for regression debugging.

## Decision: The MVP comparison should be baseline-versus-current, not a general analytics dashboard

**Rationale**: The core operator job is “did my last change make this dataset better or worse?” A simple before/after comparison solves that directly. Aggregate analytics, trends, and arbitrary slicing are secondary and would broaden scope too early.

**Alternatives considered**:
- Build multi-run analytics and trend dashboards first: rejected because it delays the concrete debugging loop.
- No persisted comparisons, only single-run output: rejected because regression detection requires a stable baseline.

## Decision: Support authenticated conversation import first, then anonymous/public import through the same eval model

**Rationale**: Authenticated history is the cleanest initial import path, but the product already supports anonymous/public chat with preserved history and shared answer-support policy. The eval model should support both, with authorization checks determining what can be imported.

**Alternatives considered**:
- Ignore anonymous/public history entirely: rejected because public chat can expose important regressions too.
- Build separate eval systems for authenticated and anonymous flows: rejected because the underlying replay and scoring model should remain shared.
