# Research: Persistent Dashboard Links

## Decision: Use one shared dashboard route-state contract

**Rationale**: The existing dashboard only persisted the top-level section and optional document id. Documents, History, Settings, and Connectors each held revisit-worthy state locally, which made refresh and share behavior inconsistent. A single shared route-state contract keeps parsing, normalization, and serialization in one place.

**Alternatives considered**:

- Parse query parameters independently inside each view: rejected because it would spread normalization logic across multiple components.
- Keep using local component state and add ad hoc copy-link helpers: rejected because refresh and browser navigation would still lose context.

## Decision: Keep the existing account dashboard path and extend it with section-specific query state

**Rationale**: The current dashboard entry point is already account-scoped and widely used. Extending it with deeper location state preserves the routing structure while adding revisitability.

**Alternatives considered**:

- Replace the dashboard route structure with many nested paths: rejected because it would create unnecessary churn and make section-specific state harder to normalize consistently.
- Use hash-only navigation for all state: rejected because list pagination and selected items are better represented as explicit location state than fragment-only state.

## Decision: Treat workspace identity as part of the persistent-link contract

**Rationale**: Dashboard content is workspace-scoped through the active workspace token. A deep link cannot reliably restore the intended location if it omits the workspace being viewed.

**Alternatives considered**:

- Leave workspace selection entirely in local storage: rejected because copied links could reopen the right section inside the wrong workspace.
- Add backend account-to-workspace resolution for links: rejected because the existing frontend workspace bootstrap already owns workspace selection and no backend change is required.

## Decision: Support only stable, meaningful deep-link surfaces in the first implementation

**Rationale**: The goal is persistent navigation to meaningful places, not preservation of every transient UI toggle. The first pass focuses on documents pagination and detail, history filter/page/detail, settings tabs and anchors, and connector selection.

**Alternatives considered**:

- Persist every transient UI state such as composer text, scroll position, or trace-graph selection: rejected because it adds complexity without clear revisit value.
- Leave settings anchors out of scope: rejected because the request explicitly called for linkable tabs and specific settings anchors.
