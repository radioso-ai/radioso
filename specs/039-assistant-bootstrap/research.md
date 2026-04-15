# Research: Assistant Bootstrap

## Decision: Keep assistant identity in General Settings, not Retrieval Settings

**Rationale**: The feature configures stable workspace persona and startup behavior, not retrieval quality. General Settings already owns workspace-wide operational settings such as anonymous chat, so placing assistant bootstrap there preserves the separation between persona/bootstrap behavior and retrieval tuning.

**Alternatives considered**:
- Store persona fields in retrieval settings: rejected because retrieval settings are already retrieval-specific and should not become a generic prompt bucket.
- Create a separate settings domain/table now: rejected because the current scope is additive and can be represented safely in existing workspace-scoped settings without introducing an extra store.

## Decision: Use request-scoped `userExpectedLocale` as the primary language input

**Rationale**: Future popup and embed surfaces need different visitors to open the same workspace in different languages. A request-scoped locale keeps language session-specific while preserving a stable workspace persona.

**Alternatives considered**:
- Make workspace language the only source of truth: rejected because it blocks multi-locale entry points for the same workspace.
- Infer locale only from the user’s first message: rejected because proactive greetings happen before a user message exists.

## Decision: Keep an optional workspace default locale as fallback only

**Rationale**: Operators may still want a sensible default when a caller does not pass a locale. Treating it as fallback avoids locking the product into a workspace-wide language model.

**Alternatives considered**:
- No workspace fallback at all: rejected because it would leave operator-configured startup behavior underspecified for dashboard usage.
- Persist the effective locale globally on the workspace: rejected because one conversation’s locale should not mutate another’s startup behavior.

## Decision: Extend the existing chat and public chat request shape with bootstrap mode rather than adding a new route

**Rationale**: The current product already has one authenticated chat entry point and one public chat entry point. Extending those request bodies with optional bootstrap semantics keeps transport changes localized and lets new chat startup share the same authorization and presentation pipeline.

**Alternatives considered**:
- Add a new `/chat/start` route: rejected for now because the user explicitly pushed toward “existing API or similar,” and the current scope does not require a separate transport seam yet.
- Create the greeting entirely on the client: rejected because the first turn must persist as a real conversation message and appear in history consistently.

## Decision: Add a focused chat bootstrap orchestration seam instead of expanding `ChatService` inline

**Rationale**: `ChatService` already owns answer generation for user-driven turns. Bootstrap behavior has different inputs and failure rules, so a small dedicated startup service keeps new-conversation orchestration explicit and avoids bloating route handlers or the existing answer path.

**Alternatives considered**:
- Put bootstrap prompt-building directly in route handlers: rejected because routes must stay transport-only.
- Fold all bootstrap branching into `ChatService.answer()`: rejected because it would mix first-turn startup behavior with the normal question-answering lifecycle.

## Decision: Apply bootstrap behavior to public chat as well as authenticated chat

**Rationale**: Public chat is the nearest current analog to a future website popup/embed flow. Shipping bootstrap only for authenticated chat would force a second redesign later.

**Alternatives considered**:
- Authenticated chat only for v1: rejected because it leaves the upcoming public/embed use case structurally incomplete.
- Different bootstrap semantics per channel: rejected because persona should remain workspace-stable across channels.

## Decision: Fail quiet on bootstrap errors and allow manual messaging

**Rationale**: A first-turn greeting is helpful but non-critical. If generation fails, the user should still be able to start chatting immediately rather than being blocked by startup orchestration.

**Alternatives considered**:
- Return a hard failure and block new chat startup: rejected because it turns a helpful enhancement into a reliability risk.
- Retry aggressively before rendering chat: rejected because startup latency and reliability matter more than forcing a greeting.
