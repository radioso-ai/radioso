# Data Model: Eval Regression Lab

## Eval Dataset

- **Represents**: A workspace-scoped collection of replayable regression cases.
- **Fields**:
  - `id`
  - `workspaceId`
  - `name`
  - `description`
  - `status`
  - `createdByUserId`
  - `createdAt`
  - `updatedAt`
- **Validation rules**:
  - `name` must be non-empty and workspace-unique within a reasonable bound
  - `status` is bounded to active or archived-style lifecycle values
- **Relationships**:
  - owns many `EvalCase` records
  - owns many `EvalRun` records

## Eval Case

- **Represents**: One replayable scenario used to detect retrieval or conversation regressions.
- **Fields**:
  - `id`
  - `datasetId`
  - `workspaceId`
  - `title`
  - `sourceType` such as `manual`, `conversation_import`, or `public_conversation_import`
  - `query`
  - `conversationContext`
  - `expectations`
  - `provenance`
  - `createdAt`
  - `updatedAt`
- **Validation rules**:
  - `query` must be non-empty
  - `conversationContext` is bounded in message count and text length
  - `expectations` may omit exact-answer checks but must include at least one scoring dimension for active cases
- **Relationships**:
  - belongs to one `EvalDataset`
  - produces many `EvalCaseResult` records across runs

## Conversation Context Snapshot

- **Represents**: The bounded history preserved with an eval case so follow-up behavior can be replayed.
- **Fields**:
  - `messages`
  - `selectionMode`
  - `sourceConversationId`
  - `sourceAssistantMessageId`
  - `sourceChannel`
- **Validation rules**:
  - messages must preserve order and role
  - only the bounded context selected during import is stored
  - content may be redacted before final save
- **Relationships**:
  - embedded in `EvalCase`
  - derived from chat history or public chat history

## Eval Case Expectation

- **Represents**: The configured criteria used to score one case.
- **Fields**:
  - `expectedDocumentIds` or stable document references
  - `expectedCitationTitles` or citation references
  - `expectedRefusalBehavior`
  - `expectedAnswerSupportOutcome`
  - `answerChecks`
  - `latencyBudgetMs`
- **Validation rules**:
  - each configured dimension is optional individually
  - at least one dimension must be configured for a runnable case
  - answer checks must be bounded and not require unrestricted semantic interpretation in the MVP
- **Relationships**:
  - belongs to one `EvalCase`
  - evaluated into one `EvalCaseScore`

## Conversation Import Draft

- **Represents**: The operator-reviewed intermediate draft created when promoting a historical turn into an eval case.
- **Fields**:
  - `sourceConversationId`
  - `sourceAssistantMessageId`
  - `sourceChannel`
  - `selectedQuery`
  - `candidateContextMessages`
  - `seededExpectations`
  - `redactions`
  - `reviewNotes`
- **Validation rules**:
  - seeded expectations are additive suggestions, not mandatory locks
  - redactions must apply before durable case persistence
- **Relationships**:
  - transformed into an `EvalCase`

## Eval Run

- **Represents**: One execution of an eval dataset against a specific workspace behavior snapshot.
- **Fields**:
  - `id`
  - `datasetId`
  - `workspaceId`
  - `baselineRunId`
  - `label`
  - `triggeredByUserId`
  - `runMetadata`
  - `summary`
  - `startedAt`
  - `completedAt`
- **Validation rules**:
  - run metadata must identify the relevant workspace settings or revision label in bounded form
  - summary counts must match stored case results
- **Relationships**:
  - belongs to one `EvalDataset`
  - owns many `EvalCaseResult` records
  - may reference one baseline `EvalRun`

## Eval Case Result

- **Represents**: The replay and scoring outcome for one eval case within one run.
- **Fields**:
  - `id`
  - `runId`
  - `caseId`
  - `status`
  - `score`
  - `dimensionResults`
  - `replayDiagnostics`
  - `comparisonOutcome`
- **Validation rules**:
  - `status` must distinguish pass, fail, skipped, and invalid cases
  - dimension results only exist for configured expectation dimensions
  - replay diagnostics remain bounded and redact-safe
- **Relationships**:
  - belongs to one `EvalRun`
  - belongs to one `EvalCase`

## Eval Case Score

- **Represents**: The dimension-by-dimension verdict used to explain why a case passed or failed.
- **Fields**:
  - `documentMatch`
  - `citationMatch`
  - `refusalMatch`
  - `answerSupportMatch`
  - `answerCheckMatch`
  - `latencyMatch`
  - `overallVerdict`
- **Validation rules**:
  - only configured dimensions contribute to `overallVerdict`
  - answer-check dimensions remain optional
- **Relationships**:
  - embedded in `EvalCaseResult`

## Replay Diagnostics Snapshot

- **Represents**: The bounded debug artifact stored with a case result so regressions can be investigated.
- **Fields**:
  - `retrievalTrace`
  - `retrievalSummary`
  - `citations`
  - `answerOutcome`
  - `answerSupportPolicy`
  - `validationSummary`
  - `timings`
- **Validation rules**:
  - may include either full bounded trace or summary-only diagnostics depending on availability
  - must exclude unrestricted raw prompts, full raw logs, secrets, and full document bodies
- **Relationships**:
  - embedded in `EvalCaseResult`
  - compared across runs by `EvalRunComparison`

## Eval Run Comparison

- **Represents**: The before/after comparison between a current run and a baseline run.
- **Fields**:
  - `baselineRunId`
  - `candidateRunId`
  - `regressions`
  - `improvements`
  - `unchanged`
  - `perCaseComparisons`
- **Validation rules**:
  - comparisons are only valid for runs from the same dataset
  - comparison reasons must be derived from bounded case results and diagnostics
- **Relationships**:
  - references two `EvalRun` records
  - aggregates many per-case comparisons
