# Research: Split Semantic And Lexical Query Rewrite

## Decision: Store split rewrite instructions additively inside retrieval settings

**Rationale**: The repo already has a workspace-scoped retrieval settings flow with validation, persistence, API exposure, and UI. Adding `semanticRewriteInstructions` and `lexicalRewriteInstructions` there preserves the existing operator mental model and keeps the feature workspace-scoped without inventing a new settings surface.

**Alternatives considered**:
- Store split rewrite instructions only in prompt code or environment variables: rejected because the approved spec requires per-workspace control through the API and UI.
- Replace `queryRewriteEnabled` with instruction presence alone: rejected because operators still need an explicit on/off control and existing workspaces already depend on the current toggle.

## Decision: Evolve rewrite output to carry mode-specific queries instead of one rewritten string

**Rationale**: The pipeline already distinguishes semantic and lexical queries downstream, but both currently originate from the same query string. Adding a split rewrite result contract with distinct semantic and lexical outputs fits the current query-interpretation seam and avoids pushing mode-specific logic into candidate retrieval stages.

**Alternatives considered**:
- Keep one rewritten query and derive the lexical query heuristically later: rejected because the point of the feature is that semantic and lexical rewriting may need different guidance.
- Let candidate retrieval stages rewrite their own queries: rejected because it would duplicate policy and weaken traceability.

## Decision: Keep phase 1 to one semantic query and one lexical query, but shape contracts for future lexical variants

**Rationale**: The user explicitly bounded phase 1 to one extensible lexical query. A single lexical query avoids extra retrieval passes and keeps latency predictable, while the internal contract can still reserve room for a future list of lexical variants if later evaluation shows that instruction-only rewriting is not stable enough.

**Alternatives considered**:
- Execute multiple lexical variants immediately: rejected because it expands candidate generation, trace complexity, and evaluation scope beyond the approved first release.
- Hard-code a permanently single-query model: rejected because it would make future lexical-variant support a breaking internal redesign.

## Decision: Use distinct semantic and lexical rewrite guidance, but keep one rewrite workflow and fallback policy

**Rationale**: Semantic rewrite should remain meaning-preserving, while lexical rewrite should prefer indexed notation, aliases, and exact literals. Those are different instructions, but the runtime should still share one bounded rewrite flow, one set of status values, and one fallback policy so the rest of the retrieval pipeline remains stable.

**Alternatives considered**:
- Build two completely separate rewrite systems with unrelated statuses and fallbacks: rejected because it complicates orchestration and diagnostics for limited benefit.
- Use one generic instruction block for both modes: rejected because it fails to address the core retrieval-quality problem.

## Decision: Make defaults explicit for backward compatibility and operator safety

**Rationale**: Existing workspaces and older clients should continue to load and save retrieval settings safely. System-defined default semantic and lexical instructions let the feature ship additively without requiring every workspace admin to configure new fields before retrieval remains usable.

**Alternatives considered**:
- Require non-empty custom instructions for both fields: rejected because it creates avoidable migration friction.
- Leave the new fields undefined all the time and branch logic everywhere: rejected because explicit defaults make validation, trace behavior, and future evolution simpler.

## Decision: Extend retrieval trace and diagnostics instead of creating a new debug surface

**Rationale**: The repo already exposes retrieval information and retrieval trace details including `semanticQuery` and `lexicalQuery`. Expanding those outputs to clearly show original query, active semantic query, active lexical query, and fallback reason gives operators the visibility they need without adding another debugging workflow.

**Alternatives considered**:
- Add a separate rewrite-debug endpoint: rejected because it duplicates the existing trace surface.
- Keep split rewrite information only in logs: rejected because the approved feature requires product-visible traceability.
