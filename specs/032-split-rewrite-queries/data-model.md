# Data Model: Split Semantic And Lexical Query Rewrite

## Retrieval Settings

- **Represents**: Workspace-scoped controls for retrieval, reranking, citation display, answer tone, metadata rules, and query rewrite behavior.
- **Key fields**:
  - workspace identifier
  - query rewrite enabled flag
  - semantic rewrite instructions
  - lexical rewrite instructions
  - rerank enabled flag
  - vector candidate count
  - similarity threshold
  - rerank candidate count
  - warmth level
  - citation display enabled flag
  - custom instruction
  - metadata rules collection
- **Rules**:
  - retrieval settings must load safely for both existing and new workspaces
  - missing split rewrite instruction fields fall back to system defaults
  - split rewrite instruction values must be validated and normalized before save
  - older clients may omit the new fields without deleting previously stored values

## Split Rewrite Settings

- **Represents**: The retrieval-settings subset that controls how query rewriting shapes semantic and lexical retrieval inputs.
- **Key fields**:
  - rewrite enabled flag
  - semantic rewrite instructions
  - lexical rewrite instructions
- **Validation rules**:
  - both instruction fields must be strings
  - blank values may normalize to system defaults rather than causing retrieval failure
  - instruction values must remain bounded in size to protect persistence and prompt construction

## Split Rewrite Result

- **Represents**: The normalized output of query rewriting for one retrieval request.
- **Key fields**:
  - original query
  - semantic query
  - lexical query
  - rewrite status
  - retrieval-eligibility decision
  - confidence
  - structured continuity result
  - fallback reason
  - rejection reason
- **Rules**:
  - semantic and lexical queries may be identical or different
  - either query may remain the original query when that is the safest supported result
  - unusable outputs must degrade to safe fallback behavior instead of breaking retrieval
  - phase 1 includes one semantic query and one lexical query only

## Active Retrieval Queries

- **Represents**: The query strings selected by the query interpretation stage for downstream retrieval execution.
- **Key fields**:
  - active semantic query
  - active lexical query
  - parsed constraints derived from the effective query interpretation
  - continuity decision for prompt-history handling
- **Rules**:
  - semantic retrieval consumes the active semantic query
  - lexical retrieval consumes the active lexical query
  - downstream stages must not replace these queries with hidden rewrites

## Rewrite Trace Record

- **Represents**: The bounded diagnostics view of split-query rewrite behavior for one execution.
- **Key fields**:
  - original query
  - active semantic query
  - active lexical query
  - rewrite status
  - rewrite ran / eligible flags
  - fallback or rejection reason
  - continuity decision
- **Rules**:
  - trace output must be understandable in product language
  - diagnostics must match the actual queries used by retrieval execution
  - trace output remains additive to the existing retrieval information surface
