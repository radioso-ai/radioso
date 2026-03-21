# Internal Stage Contracts

## Purpose

This feature does not add or change public HTTP or database contracts. The contract surface for planning is the internal retrieval orchestration boundary between the top-level pipeline entrypoint and its major stages.

## Orchestrator Contract

- The retrieval pipeline entrypoint continues accepting the current retrieval request input from callers.
- The retrieval pipeline entrypoint continues returning the current retrieval result shape, including:
  - rewritten query
  - final contexts
  - prompt
  - citations
  - response settings
  - diagnostics

## Stage Contract Expectations

Each major retrieval stage must:

- expose a focused responsibility
- accept an explicit typed input contract
- return an explicit typed output contract
- avoid hidden mutation of shared external state
- preserve deterministic behavior for the same inputs

## Planned Stage Boundaries

### Settings and Context Stage

- **Consumes**: pipeline request
- **Produces**: retrieval settings and conversation context

### Query Interpretation Stage

- **Consumes**: pipeline request plus loaded settings/context
- **Produces**: active semantic query, active lexical query, parsed constraints, rewrite status, and continuity decision

### Candidate Retrieval Stage

- **Consumes**: active retrieval queries and metadata filters
- **Produces**: raw vector and lexical candidate sets plus embedding/fallback metadata

### Candidate Preparation Stage

- **Consumes**: raw candidate sets and parsed constraints
- **Produces**: normalized, scored, and capped candidate pool

### Context Selection Stage

- **Consumes**: prepared candidate pool
- **Produces**: reranked contexts and final prompt contexts

### Prompt Assembly Stage

- **Consumes**: final prompt contexts and response settings
- **Produces**: prompt text, citations, and response settings package

### Diagnostics Assembly Stage

- **Consumes**: outputs from prior stages
- **Produces**: final retrieval diagnostics payload
