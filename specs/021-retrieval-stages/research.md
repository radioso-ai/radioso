# Research: Retrieval Pipeline Stages

## Decision: Keep a single top-level orchestrator and extract major stage modules

**Rationale**: The current pipeline is mostly linear, and the approved spec requires preserving the public entrypoint and behavior. A single orchestrator with focused stages improves modularity without framework overhead.

**Alternatives considered**:
- Introduce LangGraph or another workflow engine: rejected because the feature is an internal refactor and does not require dynamic branching, checkpointing, or agent-style workflow tooling.
- Split every helper into an injected interface: rejected because it would create indirection without better ownership or test seams.

## Decision: Use explicit stage input and output contracts for major phases

**Rationale**: The pipeline currently passes intermediate state implicitly through local variables inside one method. Defining stage contracts makes dependencies visible, stabilizes tests, and reduces hidden coupling when phases are moved.

**Alternatives considered**:
- Use one mutable pipeline state object for every phase: rejected because it would make stage boundaries less honest and easier to over-couple.
- Keep only private helper methods inside `RetrievalPipelineService`: rejected because it would leave the orchestrator owning too much policy logic.

## Decision: Treat tiny transformations as pure helpers, not always as injected stages

**Rationale**: The spec explicitly calls out interface explosion as a risk. Small deterministic transformations, such as choosing an active query or capping a merged candidate list, can remain local helpers when they do not define a true ownership seam.

**Alternatives considered**:
- Create an interface for every micro-step: rejected because it would increase complexity and make the orchestrator harder to read without adding substitution value.

## Decision: Preserve existing infrastructure ports and retrieval result shape

**Rationale**: The goal is architecture cleanup, not a behavior rewrite. Existing vector and lexical search integrations, chat callers, and retrieval result consumers should remain stable while internals are reorganized.

**Alternatives considered**:
- Redesign the full retrieval result payload while extracting stages: rejected because it would expand scope and raise regression risk.
- Push retrieval stages into chat services: rejected because it would violate the constitution’s boundary requirements.
