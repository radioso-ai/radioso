# Research: Retrieval Trace Graph

## Decision: Add `RetrievalTrace` as an additive payload beside the existing compact `retrievalInfo`

**Rationale**: The current compact summary is still useful for lightweight answer surfaces and existing consumers, but it is too flattened for operator diagnostics. Adding `RetrievalTrace` preserves compatibility while making stage order, branch participation, and decision reasons first-class.

**Alternatives considered**:
- Replace `retrievalInfo` entirely with `RetrievalTrace`: rejected because it would expand migration scope and break lightweight consumers that only need the summary.
- Encode graph details into the existing diagnostics summary shape: rejected because the existing type is optimized for rolled-up counts and status flags, not graph reconstruction.

## Decision: Persist the trace through existing audit-event metadata for history replay

**Rationale**: Chat history already reconstructs assistant-turn debug state from stored audit metadata. Reusing that path keeps persistence additive, avoids a new storage system or schema for the first release, and ensures historical answer diagnostics can be replayed consistently.

**Alternatives considered**:
- Add a dedicated retrieval-trace table: rejected because it adds schema and persistence complexity without clear first-release value.
- Return traces only on live chat responses and not on history: rejected because historical comparison is part of the approved feature scope.

## Decision: Use a deterministic stage-and-edge model with stable stage IDs and parent relationships

**Rationale**: The trace has to reconstruct a readable graph without client-side inference. Stable stage identity, stage ordering, and explicit parent or convergence relationships let the backend remain the source of truth for graph structure while keeping the frontend renderer simple.

**Alternatives considered**:
- Infer edges client-side from stage names: rejected because it would make the UI responsible for backend execution semantics.
- Store only a linear event list: rejected because branch participation such as semantic and lexical retrieval would be ambiguous.

## Decision: Capture bounded diagnostic fields, not raw prompts, full document bodies, or unrestricted logs

**Rationale**: Operators need enough information to understand why retrieval behaved as it did, but the feature must remain safe for customer data and avoid turning the UI into a raw-internals viewer. Bounded fields such as effective query, counts, settings, timings, selected ids/titles, and short reason text are sufficient for this diagnostic scope.

**Alternatives considered**:
- Include raw prompts and complete retrieval contexts in the trace: rejected because it increases sensitive-data exposure and payload size.
- Keep traces to statuses and counts only: rejected because operators would still lack the context needed to diagnose rewrite, fallback, or trimming decisions.

## Decision: Use React Flow for the operator graph visualizer

**Rationale**: The operator experience needs a directed execution graph with branches, convergence, click-to-inspect nodes, and room for status badges and detail panels. React Flow fits that UI pattern directly and keeps the visualization bounded to the product surface.

**Alternatives considered**:
- Mermaid in-product rendering: rejected because it is better suited to documentation than interactive operator diagnostics.
- A hand-built flexbox or SVG graph: rejected because it would spend implementation effort on generic graph layout instead of feature behavior.

## Decision: Do not introduce LangGraph or another workflow runtime for this feature

**Rationale**: The retrieval pipeline already has explicit staged orchestration. The feature needs observability over that deterministic flow, not a new execution runtime with dynamic loops, checkpointing, or agent orchestration.

**Alternatives considered**:
- Re-platform retrieval execution on LangGraph: rejected because it would expand scope, increase migration risk, and solve a different problem than operator diagnostics.
- Model the trace as generic workflow-engine events: rejected because it would couple the feature to infrastructure the product does not otherwise need.

## Decision: Include an answer-generation outcome node in the trace without moving answer-generation logic into retrieval

**Rationale**: Operators need to see how retrieval converged into the final answer outcome, especially for no-context or weak-grounding cases. A final answer-generation outcome node completes the diagnostic story while preserving module boundaries between retrieval and chat generation.

**Alternatives considered**:
- End the trace at prompt assembly: rejected because it hides the final grounded/no-context outcome the operator is trying to diagnose.
- Move answer generation into the retrieval pipeline to keep a single owner: rejected because it would violate current orchestration boundaries.
