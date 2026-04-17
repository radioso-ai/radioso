# Research: Conversation Modes

## Decision 1: Store conversation mode additively inside retrieval settings

- **Decision**: Add the workspace conversation mode to the existing retrieval
  settings domain, repository payload, settings routes, API schema, and admin
  settings UI instead of creating a separate settings family.
- **Rationale**: The repo already treats answer-shaping behavior as
  workspace-scoped retrieval/chat configuration. This feature is another
  workspace-level answer behavior control, and it must apply consistently to
  authenticated and public chat paths that already inherit retrieval settings.
- **Alternatives considered**:
  - Create a separate chat-style settings endpoint: rejected because it would
    split closely related chat controls across multiple surfaces with no product
    gain.
  - Store the mode only in frontend local state: rejected because the behavior
    must be enforced by the backend and shared across all entry points.

## Decision 2: Use `guided` as the explicit default

- **Decision**: Default unsaved workspaces to `guided`.
- **Rationale**: `guided` is the product’s center of gravity: it preserves
  direct answering while adding modest grounded discovery. `factual` is too
  terse as the default, and `exploratory` risks token bloat and over-eager
  expansion for new workspaces.
- **Alternatives considered**:
  - Default to `factual`: rejected because it preserves the current terseness
    the feature is meant to improve.
  - Default to `exploratory`: rejected because it would make the most expansive
    behavior the baseline before operators learn its tradeoffs.

## Decision 3: Split behavior across prompt-time strategy and post-answer expansion

- **Decision**: Implement conversation mode with two bounded seams:
  prompt-time response-strategy instructions plus a post-answer grounded
  expansion planner/composer.
- **Rationale**: Prompt-only control is too soft and makes `exploratory` drift
  into “slightly longer prose.” A second bounded seam lets the system control
  whether focused or expansive continuations appear, how many there are, and how
  clearly they are separated from the direct answer.
- **Alternatives considered**:
  - Encode the entire feature in one large answer prompt: rejected because it
    weakens control, observability, and testability.
  - Add expansion only after unsupported answers: rejected because the approved
    spec requires the mode to shape all answers, not just misses.

## Decision 4: Reuse the current turn’s grounded context by default

- **Decision**: Focused and expansive continuations should be derived from the
  same retrieved context set already assembled for the turn, without triggering
  a second retrieval path by default.
- **Rationale**: Reusing the current grounded context preserves latency,
  simplifies the trust boundary, and aligns with the spec’s requirement that
  expansions be drawn from already grounded material.
- **Alternatives considered**:
  - Run a second retrieval pass for exploratory mode: rejected because it adds
    complexity, latency, and new ranking semantics outside the approved scope.
  - Allow generic model knowledge for exploratory suggestions: rejected because
    it breaks the grounded-product contract.

## Decision 5: Represent exploration as focused and expansive continuations, not separate answer outcomes

- **Decision**: Add mode-driven continuation metadata while preserving the
  existing answer-support and outcome classification model.
- **Rationale**: The feature changes how a grounded answer is presented, not the
  fundamental meaning of supported, degraded, or no-context turns. Existing
  history, replay, and debug surfaces already understand those outcomes.
- **Alternatives considered**:
  - Introduce new assistant-turn outcomes such as `guided_success` or
    `exploratory_success`: rejected because that bloats audit semantics for a
    presentation-layer feature.

## Decision 6: Honor explicit user requests for brevity per turn

- **Decision**: If the user explicitly asks for a brief, direct, or “just the
  answer” response, that turn should suppress optional mode-driven expansion.
- **Rationale**: Workspace defaults should shape the baseline experience, but
  direct user intent should win for the current turn or the feature will feel
  rigid and annoying.
- **Alternatives considered**:
  - Ignore the user’s brevity request and keep applying the workspace mode:
    rejected because it creates obvious frustration.
  - Persist a user-level override automatically: rejected because the approved
    scope is workspace-scoped conversation mode, not per-user preference
    management.

## Decision 7: Add dedicated prompt assets under `backend/prompts/`

- **Decision**: If new runtime model instructions are needed for conversation
  mode behavior, store them under `backend/prompts/chat/` and keep them separate
  from unsupported-notice and grounded-miss prompt assets.
- **Rationale**: The constitution requires runtime prompt assets to live under
  `backend/prompts/`, and the feature introduces a distinct product behavior
  that deserves clear prompt ownership rather than hidden inline strings.
- **Alternatives considered**:
  - Add inline prompt fragments inside `promptBuilder.ts` or `chatService.ts`:
    rejected because it makes the behavior harder to audit and evolve.

## Decision 8: Extend existing debug/history metadata instead of inventing new endpoints

- **Decision**: Surface the active conversation mode and expansion-application
  flags through existing chat response metadata, audit metadata, and chat history
  debug views.
- **Rationale**: Operators already inspect those surfaces for answer-support
  behavior. Extending them keeps observability coherent and avoids creating
  another operator-only API just for this feature.
- **Alternatives considered**:
  - Build a new debug endpoint for conversation mode: rejected because it adds
    surface area without improving the core product.
