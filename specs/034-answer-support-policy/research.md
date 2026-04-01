# Research: Configurable Answer Support Policy

## Decision: Store the answer-support policy additively inside retrieval settings

**Rationale**: The repo already has a workspace-scoped retrieval settings flow with validation, persistence, API exposure, and UI. Adding the answer-support policy there preserves the existing operator mental model and keeps the behavior workspace-scoped without inventing a second settings surface.

**Alternatives considered**:
- Store the policy in chat-only configuration: rejected because the user expects this to be a workspace setting that affects all chat entry points consistently.
- Make the policy a frontend-only preference: rejected because the enforcement and audit behavior live on the backend.

## Decision: Use three explicit modes rather than a boolean toggle

**Rationale**: `strict`, `warn`, and `off` reflect three distinct product behaviors: replace unsupported content, preserve it with diagnostics, or disable post-generation support replacement. A boolean would collapse materially different operator choices into an ambiguous on/off setting.

**Alternatives considered**:
- Boolean `strictGrounding`: rejected because it cannot represent the approved middle state where unsupported content is preserved but still flagged.
- Separate toggles for replacement and diagnostics: rejected because it creates invalid combinations and weakens UX clarity.

## Decision: Keep `strict` as the default for backward compatibility

**Rationale**: Existing workspaces currently rely on the hard-coded strict replacement behavior. Defaulting to `strict` preserves safety and avoids silently loosening grounding behavior for existing users.

**Alternatives considered**:
- Default to `warn`: rejected because it would expose unsupported content to existing workspaces without explicit operator consent.
- Require every workspace to choose a mode before chat works: rejected because it adds migration friction and is unnecessary.

## Decision: Replace the hard-coded English fallback with a bounded generated non-verification notice

**Rationale**: The current static English sentence is a poor UX fit for multilingual workspaces. A bounded generated notice can keep strict mode safe while matching the user’s language and the specific unsupported scope. The generation step is limited to reframing unsupported content as non-verification, not re-answering the question.

**Alternatives considered**:
- Static localized templates: rejected because the user cannot rely on a fixed set of known languages and wants dynamic language matching.
- Reuse the original unsupported segment with a disclaimer prefix: rejected because it risks leaking unsupported substantive claims back into the answer.

## Decision: Keep support-detection heuristics unchanged in this feature

**Rationale**: The feature request is about who controls the post-detection policy, not about retraining or redesigning the support classifier. Holding heuristics stable limits scope and keeps failures attributable to either retrieval quality or policy choice.

**Alternatives considered**:
- Tune support detection and policy together: rejected because it broadens the feature into retrieval-quality work and muddies regressions.
- Disable validation entirely in `off`: rejected because operators still need diagnostics and visibility into whether unsupported content was detected.

## Decision: Apply the same workspace policy to authenticated and anonymous/public chat

**Rationale**: A workspace should have one coherent answer-grounding behavior regardless of entry point. Diverging authenticated and public behavior would make operator expectations and debugging harder.

**Alternatives considered**:
- Force anonymous/public chat to remain strict: rejected because the user explicitly approved shared policy behavior.
- Add separate public policy settings: rejected because it expands scope into multi-policy management.

## Decision: Extend existing diagnostics and history artifacts instead of creating a new debug surface

**Rationale**: The repo already persists validation summaries, answer outcomes, and retrieval trace metadata. Adding the active answer-support policy to those artifacts keeps policy decisions inspectable without adding another endpoint or audit store.

**Alternatives considered**:
- Create a separate validation-policy debug endpoint: rejected because it duplicates existing history/debug surfaces.
- Keep policy decisions only in logs: rejected because the feature requires user-visible and operator-visible traceability.
