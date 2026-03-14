# Research: Chat Response Controls

## Decision 1: Reuse the existing account-scoped settings model

**Decision**: Store new response controls alongside the existing retrieval settings record rather than introducing a new settings table or endpoint family.

**Rationale**: The product already treats retrieval behavior as account-scoped configuration. Warmth and citation-display behavior share that same scope and lifecycle, so extending the current settings seam keeps persistence, routing, and auditing simple.

**Alternatives considered**:

- Create a separate response-settings table and service: rejected because it adds parallel persistence and transport seams for a small, closely related set of account preferences.
- Keep response controls in frontend local state only: rejected because the behavior must persist across sessions and apply consistently to backend answer generation.

## Decision 2: Enforce the closing-question rule in backend answer instructions

**Decision**: Encode the “no trailing engagement questions” behavior in backend-generated answer instructions rather than trimming or rewriting answers after generation.

**Rationale**: The model needs to know the policy before generation so it can produce natural endings and still ask clarifying questions when necessary. Post-processing text after generation is brittle and risks corrupting legitimate questions or harming answer quality.

**Alternatives considered**:

- Regex removal of trailing question marks or common phrases: rejected because it cannot distinguish valid clarification questions from unwanted conversational prompts.
- Frontend-only suppression of the last sentence: rejected because it would create inconsistency between JSON, SSE, persistence, and any future API consumer.

## Decision 3: Move citation placement ownership to the backend

**Decision**: Replace frontend positional citation heuristics with backend-owned structured answer metadata that maps supporting sources to answer segments.

**Rationale**: The backend knows which contexts were supplied to answer generation and can preserve deliberate citation placement rules. The frontend should render citation metadata, not infer it. This is the only durable way to prevent repeated references to the same source from appearing in arbitrary places.

**Alternatives considered**:

- Keep the current frontend heuristic and only deduplicate by source id: rejected because it reduces visual noise but still places citations on the wrong claims.
- Remove inline citations entirely: rejected because the product still needs grounded answers when citation display is enabled.

## Decision 4: Keep citations optional in the response contract

**Decision**: Model citations and structured answer citation metadata as optional fields in the chat response and SSE completion payload.

**Rationale**: Citation visibility is a presentation choice, not a requirement for grounding. Making citation fields optional allows the system to omit markers when the preference is disabled, when no support exists, or when a future client chooses plain-text rendering.

**Alternatives considered**:

- Require citations in every response: rejected because it would block turning markers off later and would misrepresent answers that legitimately have no citations to show.
- Hide citations only in the frontend while always returning populated marker metadata: rejected because it keeps clients coupled to fields they may not want and does not clearly express optionality in the contract.

## Decision 5: Preserve stream/non-stream completion parity

**Decision**: Return the same final structured completion metadata in both non-streaming chat responses and streaming `done` events.

**Rationale**: The frontend already unifies the two paths at completion time. Preserving a shared completion shape avoids divergent rendering logic and ensures the final visible answer behaves identically regardless of transport mode.

**Alternatives considered**:

- Keep richer citation metadata only for non-streaming responses: rejected because it would force the frontend to use different rendering rules by mode.
- Stream citation markers inline with text chunks: rejected because partial marker delivery complicates rendering and makes deduplication harder.

## Decision 6: Validate the feature with backend-first tests and targeted UI verification

**Decision**: Use backend TDD for settings, prompt policy, and chat contract behavior, then verify frontend rendering and settings interactions against the completed backend contract.

**Rationale**: Most feature risk sits in backend policy and contract shape. Frontend behavior becomes straightforward once the contract is stable and metadata ownership is correct.

**Alternatives considered**:

- Start in the frontend by changing the warmth slider and citation renderer first: rejected because the UI would still be blocked on missing backend capabilities.
- Rely on manual verification only: rejected because closing-question and citation-dedup behavior need repeatable regression coverage.
