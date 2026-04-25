# Data Model: Model-Level Social Turn Intent

## Response Intent Decision

Represents the model-derived routing decision for one chat turn before
retrieval runs.

### Fields

- `responseIntent`: one of `retrieval`, `social_only`, `assistant_identity`
- `confidence`: bounded numeric confidence from the interpretation pass
- `turnKind`: existing retrieval rewrite interpretation for retrieval-oriented
  follow-up semantics
- `semanticQuery`: active semantic retrieval query when retrieval remains
  required
- `lexicalQuery`: active lexical retrieval query when retrieval remains
  required
- `responseLanguagePolicy`: current rule for matching the user’s language

### Relationships

- Produced by the query-interpretation model pass.
- Consumed by chat orchestration to decide whether to short-circuit retrieval.
- Reused by the retrieval pipeline when the turn remains retrieval-backed.

## Shared Answer Instruction Context

Represents the workspace-scoped answer-shaping inputs that must stay available
to both retrieval-backed and non-retrieval prompts.

### Fields

- `assistantIdentity`: stable assistant name and role, when configured
- `customInstruction`: workspace-specific answer guidance
- `conversationMode`: factual, guided, or exploratory
- `responseLanguagePolicy`: current response-language rule for the turn

### Relationships

- Built from workspace settings and request-scoped language behavior.
- Used by retrieval prompt assembly and by non-retrieval social or identity
  prompt assembly.

## Chat Routing Diagnostics

Represents additive stored metadata describing which path the current turn
followed.

### Fields

- `responseIntent`: `retrieval`, `social_only`, or `assistant_identity`
- `retrievalSkipped`: boolean indicating whether retrieval was intentionally
  skipped
- `intentConfidence`: optional bounded confidence
- `intentFallbackApplied`: boolean indicating whether intent output was unusable
  and the system fell back to normal retrieval behavior

### Relationships

- Stored alongside existing assistant-turn diagnostics and audit metadata.
- Used by engineers to distinguish intent-routing issues from retrieval or
  validation issues.
