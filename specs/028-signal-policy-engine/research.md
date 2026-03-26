# Research: Generic Retrieval Signal Policies

## Decision: Add a new `signal_policies` settings column and migrate from `attribute_controls`

**Rationale**: The feature goal is to replace the legacy `attributeControls` model, not merely rename it in the API layer. Adding `signal_policies` lets the runtime and HTTP contract move to the new representation cleanly while preserving existing workspaces through an additive migration. The repository can still read legacy rows safely during transition, but new writes will use the new column only.

**Alternatives considered**:
- Reuse the `attribute_controls` column with a new payload shape: rejected because the storage name would keep the legacy concept embedded at the persistence seam and make future cleanup harder.
- Break compatibility and require manual database intervention: rejected because the approved spec requires existing workspaces to keep loading and saving without repair work.

## Decision: Model policies around generic `signalKey` + `valueType` + `mode`

**Rationale**: The current bottleneck is the family enum baked into validation and matching. A policy object with a freeform `signalKey`, a bounded generic `valueType`, and a behavior `mode` preserves safe validation while opening the model to additional signals later. This keeps the first release bounded without exposing a rule DSL.

**Alternatives considered**:
- Make `signalKey` fully untyped and accept arbitrary JSON blobs: rejected because it weakens validation and increases debugging risk.
- Replace the current families with a different hard-coded enum only: rejected because it changes names without changing the architecture.

## Decision: Introduce a typed signal-evaluator registry in retrieval

**Rationale**: The current scorer matches constraints with one branch per legacy family. A registry keyed by generic `valueType` keeps domain logic modular: parsing produces generic constraints, policies select which signals are active, and evaluator implementations handle comparison logic by type.

**Alternatives considered**:
- Keep all matching logic in one service with renamed branches: rejected because it would preserve the same architecture drift under a new label.
- Build a user-authored rule engine now: rejected because it is outside the approved scope and unnecessary for the first generic-policy release.

## Decision: Keep the initial UI generic but catalog-backed

**Rationale**: The settings UI must stop showing the four legacy family controls, but the first version still needs understandable labels for the built-in default signals. A small UI catalog keyed by signal key, with a fallback renderer for unknown signals, gives a generic management surface without blocking future backend-added signals.

**Alternatives considered**:
- Ask admins to type raw signal keys manually: rejected because it is too low-level for the existing settings UX.
- Add a server-driven dynamic signal-catalog API in this feature: rejected because it expands the scope beyond what is needed to ship the new model safely.

## Decision: Keep query parsing bounded but emit generic constraints

**Rationale**: The approved spec does not require a full query-understanding redesign. The current parser can stay limited to the same kinds of user literals as long as it now emits generic signal keys and value types instead of legacy family enums. That preserves current retrieval behavior while removing the enum dependency.

**Alternatives considered**:
- Delay parser changes and only rename the settings model: rejected because retrieval would still depend on family-specific identifiers.
- Expand to arbitrary metadata parsing now: rejected because it would materially widen scope beyond the approved feature.
