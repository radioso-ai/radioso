# Data Model: Conversational Subject Continuity

## 1. SubjectReference

Represents the normalized subject identity used for convergence and carry-forward decisions.

### Fields

- `canonicalLabel`: normalized display label chosen from grounded retrieval evidence
- `normalizedKey`: normalized comparison key or equivalence-class key used across labels and aliases
- `aliases`: optional list of alternate labels observed in retrieved chunks
- `stableId`: optional stable identifier when a document/entity/product id is available
- `subjectType`: optional category such as person, place, company, product, document

### Validation Rules

- `canonicalLabel` must be non-empty after normalization
- `normalizedKey` must be deterministic for equivalent labels
- `aliases` must exclude empty or duplicate entries
- `stableId` and `subjectType` are optional for v1

## 2. SubjectConvergenceMetrics

Deterministic metrics used to decide whether one subject safely wins for the current turn.

### Fields

- `winningSubject`: `SubjectReference | null`
- `runnerUpSubject`: `SubjectReference | null`
- `supportCount`: number of high-ranking candidates for the winning subject
- `scoreMass`: aggregate normalized score mass for the winning subject
- `runnerUpScoreMass`: aggregate normalized score mass for the runner-up subject
- `winnerMargin`: margin between winner and runner-up
- `agreementAcrossPaths`: whether raw and subject-biased retrieval converge on the same normalized subject
- `isComparative`: whether the current turn remains multi-subject by design
- `isAmbiguous`: whether current evidence remains split

### Validation Rules

- `supportCount` cannot be negative
- `scoreMass`, `runnerUpScoreMass`, and `winnerMargin` cannot be negative
- `winningSubject` must be null when `isAmbiguous` is true and no single subject safely wins

## 3. SubjectReuseState

Conversation-scoped retrieval state used to carry the trusted subject across turns.

### Fields

- `resolvedSubject`: `SubjectReference | null`
- `resolutionOutcome`: one of `reused`, `newly_established`, `replaced`, `cleared`, `unresolved`
- `resolutionConfidence`: bounded numeric score derived from deterministic convergence metrics
- `resolutionSourceTurnId`: id of the turn whose retrieval most recently established or changed the state
- `resolutionEvidence`: `SubjectConvergenceMetrics`
- `stateVersion`: monotonic version for future evolution of the state format

### State Transitions

- `null -> newly_established`: current turn converges on one normalized subject
- `reused -> reused`: current turn continues to support the same subject
- `reused -> replaced`: current turn converges on a different subject
- `reused -> cleared`: current turn becomes ambiguous, comparative, or self-contained against the old subject
- `any -> unresolved`: current turn does not produce enough evidence for a trusted carry-forward decision

## 4. RetrievalIntent

Internal structured input passed to rewrite and retrieval decisions without mutating the user-visible message.

### Fields

- `rawUserMessage`: the original current-turn text
- `historyWindow`: selected recent conversation context
- `carriedSubject`: `SubjectReference | null`
- `mode`: one of `raw` or `subject_biased`
- `selfContainedHint`: optional signal from retrieval/context services indicating whether carry-forward is likely needed

### Validation Rules

- `rawUserMessage` must exactly match the stored/displayed user turn
- `mode=subject_biased` requires `carriedSubject`
- `historyWindow` is bounded by the existing conversation-window rules

## 5. RetrievalContinuityDiagnostics

Additive diagnostic information recorded for retrieval info surfaces and tests.

### Fields

- `subjectReuseOutcome`
- `rawPathWinningSubject`
- `biasedPathWinningSubject`
- `winningSubject`
- `runnerUpSubject`
- `supportCount`
- `scoreMass`
- `winnerMargin`
- `agreementAcrossPaths`
- `disagreementDetected`

### Validation Rules

- `disagreementDetected` must be true when raw and biased path winners differ materially
- `winningSubject` may be null when outcome is `cleared` or `unresolved`
