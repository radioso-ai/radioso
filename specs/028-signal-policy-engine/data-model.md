# Data Model: Generic Retrieval Signal Policies

## Retrieval Settings

- **Represents**: Workspace-scoped controls for retrieval, reranking, citation display, answer tone, and retrieval signal policies.
- **Key fields**:
  - workspace identifier
  - query rewrite enabled flag
  - rerank enabled flag
  - vector candidate count
  - similarity threshold
  - rerank candidate count
  - warmth level
  - citation display enabled flag
  - custom instruction
  - signal policies collection
- **Rules**:
  - retrieval settings must load safely for both new and legacy workspaces
  - signal policies must be validated before save
  - missing signal policies fall back to system defaults

## Retrieval Signal Policy

- **Represents**: One workspace-scoped rule describing how a named retrieval signal affects ranking or filtering.
- **Key fields**:
  - signal key
  - generic value type
  - enabled flag
  - behavior mode
- **Validation rules**:
  - signal key must be a non-empty string
  - value type must be one of the supported generic value types
  - behavior mode must be one of the supported policy strategies
  - a workspace cannot store duplicate policies for the same signal key

## Legacy Attribute Control

- **Represents**: The pre-feature retrieval settings entry keyed by one of four fixed families.
- **Key fields**:
  - family identifier
  - enabled flag
  - mode
- **Rules**:
  - legacy controls are migration input only
  - reads may still translate them for older rows until all workspaces have new signal policies stored

## Parsed Query Constraint

- **Represents**: A retrieval-time interpretation of a user literal that can be applied generically against candidate signals.
- **Key fields**:
  - signal key
  - value type
  - operator
  - confidence
  - source text
  - typed comparison payload
- **Rules**:
  - constraints must be independent from legacy attribute-family identifiers
  - constraints may be dropped from lexical stripping and policy application when no enabled policy matches the signal key

## Signal Evaluator

- **Represents**: A focused retrieval-domain component that compares a parsed constraint against candidate signal values for one generic value type.
- **Key fields**:
  - supported value type
  - comparison behavior for supported operators
- **Rules**:
  - evaluators remain domain-only and must not own settings persistence or UI concerns
  - unsupported signal types fail safely by skipping policy application rather than breaking retrieval
