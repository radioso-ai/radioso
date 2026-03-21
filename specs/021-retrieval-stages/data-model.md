# Data Model: Retrieval Pipeline Stages

## Retrieval Pipeline Request

- **Represents**: The caller-provided input to the retrieval pipeline.
- **Key fields**:
  - workspace identifier
  - user query
  - prior message history
  - rewrite carry-forward literals
  - optional metadata filter

## Retrieval Context

- **Represents**: Shared context loaded before interpretation and retrieval begin.
- **Key fields**:
  - retrieval settings
  - selected conversation window
  - original query text
  - caller history and metadata filters

## Query Interpretation

- **Represents**: The normalized understanding of the input query after parsing and optional rewrite.
- **Key fields**:
  - original parsed query
  - rewrite decision and status
  - rewritten parsed query when applicable
  - merged parsed query
  - active semantic query
  - active lexical query
  - continuity decision

## Candidate Retrieval Result

- **Represents**: Raw candidate sets gathered before normalization and scoring.
- **Key fields**:
  - query embedding
  - semantic candidate set
  - lexical candidate set
  - fallback indicators

## Prepared Candidate Set

- **Represents**: The merged and scored candidate pool ready for reranking or final selection.
- **Key fields**:
  - normalized candidates
  - applied attribute constraints
  - candidate cap or fallback decisions

## Final Prompt Context

- **Represents**: The ordered retrieval evidence passed into prompt assembly.
- **Key fields**:
  - selected contexts
  - rerank status
  - final context count

## Retrieval Prompt Package

- **Represents**: The final prompt-ready output for the chat layer.
- **Key fields**:
  - prompt text
  - citations mapping
  - response settings

## Retrieval Diagnostics Payload

- **Represents**: The diagnostics object returned with the retrieval result.
- **Key fields**:
  - rewrite status
  - rerank status
  - candidate counts by source
  - applied constraints
  - continuity decision
  - fallback indicators
