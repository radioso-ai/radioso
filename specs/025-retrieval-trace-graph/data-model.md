# Data Model: Retrieval Trace Graph

## 1. Retrieval Trace

Bounded diagnostic record for one retrieval-backed assistant answer.

### Fields

- `traceId`: Stable identifier for this trace
- `conversationId`: Conversation correlation identifier
- `assistantMessageId`: Assistant turn correlation identifier when available
- `startedAt`: Trace start timestamp
- `completedAt`: Trace completion timestamp when available
- `totalDurationMs`: Total bounded execution duration
- `stages`: Ordered list of `RetrievalTraceStage`
- `links`: Explicit branch or convergence relationships between stage ids
- `summary`: Optional compact retrieval-summary snapshot retained for compatibility

### Validation Rules

- `traceId` is stable for one recorded answer execution
- `stages` are ordered deterministically for the same execution facts
- Every link references valid stage ids
- The trace remains bounded and excludes prohibited sensitive content

### Notes

- The first release treats the backend as the source of truth for stage ordering and graph structure
- The trace is additive to, not a replacement for, the existing compact retrieval summary

## 2. Retrieval Trace Stage

One logical execution step or branch in the trace graph.

### Fields

- `stageId`: Stable identifier unique within one trace
- `kind`: Logical stage kind such as context, interpretation, semantic retrieval, lexical retrieval, candidate preparation, rerank, prompt selection, prompt assembly, answer outcome, or diagnostics
- `label`: Operator-facing stage label
- `status`: Stage outcome such as `applied`, `skipped`, `fallback`, `rejected`, `unavailable`, or `failed`
- `startedAt`: Stage start timestamp when available
- `durationMs`: Stage duration when available
- `settings`: Bounded settings that materially affected this stage
- `inputs`: Bounded stage inputs shown for diagnostics
- `outputs`: Bounded stage outputs shown for diagnostics
- `metrics`: Bounded counts, score summaries, or timing metrics
- `reason`: Short reason text for skip, fallback, rejection, failure, or trimming decisions

### Validation Rules

- `stageId` is stable and unique within one trace
- `status` comes from the supported bounded outcome set
- `settings`, `inputs`, `outputs`, and `metrics` remain bounded and omit prohibited sensitive content
- `reason` is optional but present when the stage outcome materially changes the final result

## 3. Retrieval Trace Link

Relationship between two stages used to reconstruct branch flow or convergence.

### Fields

- `fromStageId`: Upstream stage id
- `toStageId`: Downstream stage id
- `kind`: Relationship kind such as `sequence`, `branch`, or `converge`

### Validation Rules

- `fromStageId` and `toStageId` must reference existing stages
- Links must not create contradictory ordering

## 4. Retrieval Trace Summary Snapshot

Compatibility summary kept alongside the richer trace for existing answer surfaces.

### Fields

- `parsedQuery`: Existing bounded parsed-query view when available
- `candidateCounts`: Existing bounded candidate counts
- `appliedConstraints`: Existing applied-constraint list
- `fallbackApplied`: Existing fallback indicator
- `rerankStatus`: Existing rerank status
- `rewrite`: Existing bounded rewrite information

### Validation Rules

- Summary values must remain consistent with the underlying trace
- Existing summary fields remain backward-compatible for current consumers

## 5. Chat Answer Response Model Additions

Additive answer payload fields for immediate operator inspection after a chat turn completes.

### Fields

- `retrievalInfo`: Existing compact summary
- `retrievalTrace`: Optional full `RetrievalTrace` for the completed answer

### Validation Rules

- `retrievalInfo` remains present where currently required
- `retrievalTrace` is included for eligible retrieval-backed answers or omitted only when unavailable by design

## 6. Chat History Debug Model Additions

Stored and replayed assistant-turn debug metadata for historical inspection.

### Fields

- `eventStatus`: Existing success or failure state
- `recordedAt`: Existing audit timestamp
- `stream`: Existing streaming flag
- `citationCount`: Existing citation count
- `retrievalInfo`: Existing compact summary
- `retrievalTrace`: Optional stored `RetrievalTrace`
- `errorMessage`: Existing failure text when present

### Validation Rules

- Historical debug data may omit `retrievalTrace` for older answers
- The UI must distinguish omitted historical traces from empty successful traces

## 7. Retrieval Trace Graph View Model

Frontend-ready visualization model derived from `RetrievalTrace`.

### Fields

- `nodes`: Visual graph nodes mapped from stages
- `edges`: Visual graph edges mapped from links
- `selectedStageId`: Currently focused stage
- `rawTrace`: Raw `RetrievalTrace` shown in the detail surface

### Validation Rules

- The view model must not invent new backend facts
- Visual ordering must preserve backend-provided stage sequencing and relationships

## 8. Stage-Specific Diagnostic Content

Bounded diagnostic content expected for key stage kinds.

### Context Stage

- conversation-history window summary
- truncation flag
- metadata-filter summary
- retrieval-settings snapshot

### Query Interpretation Stage

- original query
- effective retrieval query
- rewrite status
- rewrite eligibility
- continuity decision
- parsed semantic and lexical query summary
- supported constraints summary

### Candidate Retrieval Branch Stages

- retrieval path kind
- query used
- top-k and threshold settings
- candidate counts
- latency
- skip or fallback reason when applicable

### Candidate Preparation Stage

- merge and dedup counts
- applied constraint outcomes
- fallback or relaxation decisions
- bounded drop reasons

### Context Selection Stage

- rerank status
- rerank input and output counts
- final context count
- trimming or budget reason

### Prompt Assembly Stage

- citation display setting
- warmth setting
- citation count
- prompt-context count

### Answer Outcome Stage

- no-context versus grounded outcome
- stream versus non-stream mode
- answer-generation duration when available

### Diagnostics Stage

- final fallback summary
- final status roll-up
- trace completeness indicator

## 9. State Transitions

### Live Chat Execution

1. Retrieval pipeline stages execute
2. Trace assembly derives bounded `RetrievalTrace` from stage facts
3. Compact `retrievalInfo` summary is derived
4. Chat response returns `retrievalInfo` and `retrievalTrace`
5. Audit metadata persists summary and trace for historical replay

### Historical Replay

1. Chat history loads assistant-turn audit metadata
2. Compact summary is rebuilt or read from stored diagnostics
3. Stored `retrievalTrace` is returned when present
4. UI renders graph, raw trace, or explicit unavailable state
