# Research: History-Aware Expansive Suggestions

## Decision 1: Reuse Existing Conversation History Instead Of Persisting New Intent State

- **Decision**: Build the suggestion planner from the current turn, recent in-memory conversation history, and the already selected grounded contexts.
- **Rationale**: The current chat pipeline already passes history into answer generation and keeps enough context in memory for the turn. Reusing that avoids schema changes and keeps the feature inside the current latency envelope.
- **Alternatives considered**:
  - Persist an explicit "conversation intent" record for every turn: rejected because it adds schema and lifecycle complexity without being required for this feature.
  - Infer broader suggestions only from the final answer text: rejected because it recreates the current failure mode.

## Decision 2: Add Grouped Suggestion Types Instead Of Overloading A Flat List

- **Decision**: Extend suggestion payloads so each suggestion carries a group or kind identifying `deeper` vs `broader`.
- **Rationale**: The frontend needs an explicit signal to render grouped lanes consistently, and backend tests need a clear contract for exploratory behavior.
- **Alternatives considered**:
  - Infer groups on the frontend from suggestion text: rejected because it hides behavior in UI heuristics and breaks multilingual correctness.
  - Keep one flat list and rely on ordering alone: rejected because it is fragile and obscures the product distinction.

## Decision 3: Keep Group Planning In A Focused Chat Domain Module

- **Decision**: Extend `conversationModeExpansionService.ts` or split helpers around it so grouped planning, parsing, and deduplication stay outside `chatService.ts`.
- **Rationale**: `chatService.ts` already orchestrates multiple concerns. Pushing history-aware grouping into focused helpers protects modularity and keeps tests targeted.
- **Alternatives considered**:
  - Put all planning logic directly in `chatService.ts`: rejected because it violates the architecture constraints.
  - Push grouping into retrieval services: rejected because suggestion grouping is answer-expansion behavior, not retrieval ownership.

## Decision 4: Preserve Existing Provenance And Count Controls

- **Decision**: Grouped suggestions keep existing click provenance fields and still honor workspace enable/count settings.
- **Rationale**: The feature should enrich exploratory behavior without changing how the rest of the product reasons about suggestion clicks or operator controls.
- **Alternatives considered**:
  - Introduce separate count controls per group: rejected as out of scope.
  - Add new click-tracking infrastructure: rejected because existing message provenance already covers the requirement.
