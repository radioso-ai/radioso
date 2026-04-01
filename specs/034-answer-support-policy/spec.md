# Feature Specification: Configurable Answer Support Policy

**Feature Branch**: `034-answer-support-policy`  
**Created**: 2026-04-01  
**Status**: Draft  
**Input**: User description: "Expose answer support validation policy in the retrieval settings UI and API with strict, warn, and off modes that apply to both authenticated and anonymous/public chat."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose How Strict Grounding Enforcement Should Be (Priority: P1)

As a workspace admin, I want to choose how the product handles answer segments
that are not supported by retrieved evidence so the assistant behavior matches
my workspace’s tolerance for strict grounding versus answer continuity.

**Why this priority**: This is the core product decision. Without a
workspace-scoped policy, all users are forced into one hard-coded grounding
behavior even when their trust and usability tradeoffs differ.

**Independent Test**: Can be fully tested by changing the workspace setting,
asking a retrieval-backed question that produces unsupported answer content, and
verifying that the final visible answer follows the selected policy.

**Acceptance Scenarios**:

1. **Given** a workspace is set to `strict`, **When** a retrieval-backed answer
   contains unsupported substantive content, **Then** the final visible answer
   replaces unsupported content with a short non-verification notice generated
   in the user’s language without adding unsupported facts.
2. **Given** a workspace is set to `warn`, **When** a retrieval-backed answer
   contains unsupported substantive content, **Then** the final visible answer
   keeps the answer text while still recording that unsupported content was
   detected.
3. **Given** a workspace is set to `off`, **When** a retrieval-backed answer
   contains unsupported substantive content, **Then** the system does not apply
   post-generation support replacement for that answer.

---

### User Story 2 - Configure Policy In Retrieval Settings (Priority: P2)

As a workspace admin, I want to control the answer-support policy from the same
retrieval settings surface where other grounding and citation behavior already
lives so I can manage answer behavior without code changes.

**Why this priority**: A policy is only operationally useful if it can be
configured and reviewed where workspace retrieval behavior is already managed.

**Independent Test**: Can be fully tested by saving the policy through the
settings API and settings UI, reloading the workspace settings, and verifying
that the saved value round-trips unchanged and later affects both authenticated
and anonymous/public chat answers in that workspace.

**Acceptance Scenarios**:

1. **Given** a workspace admin opens retrieval settings, **When** they review
   grounding behavior controls, **Then** they can choose between `strict`,
   `warn`, and `off` in plain language.
2. **Given** a workspace admin saves one of the supported policy values,
   **When** retrieval settings are fetched again later, **Then** the same value
   is returned unchanged for that workspace.
3. **Given** one workspace is configured with `strict` and another with `warn`
   or `off`, **When** similar retrieval-backed answers are generated, **Then**
   each workspace applies only its own configured policy.

---

### User Story 3 - Preserve Debuggability Across Policy Modes (Priority: P3)

As an operator investigating a suspicious answer, I want chat history and debug
surfaces to continue showing whether validation ran, what policy was active, and
whether the delivered answer was modified so I can understand the outcome
without reconstructing it from logs.

**Why this priority**: Once answer-support handling becomes configurable,
operators need enough visibility to tell whether a surprising answer came from
retrieval quality, generated content, or the selected support policy.

**Independent Test**: Can be fully tested by exercising each policy mode on a
retrieval-backed answer with unsupported content and verifying that stored turn
diagnostics reflect the active policy and the modification outcome.

**Acceptance Scenarios**:

1. **Given** a retrieval-backed answer is processed under `strict`, **When** an
   operator inspects the stored turn diagnostics, **Then** they can see that
   validation ran, the active policy was `strict`, and the answer was modified.
2. **Given** a retrieval-backed answer is processed under `warn`, **When** an
   operator inspects the stored turn diagnostics, **Then** they can see that
   validation ran, the active policy was `warn`, and the answer was not replaced
   even though unsupported content was detected.
3. **Given** a retrieval-backed answer is processed under `off`, **When** an
   operator inspects the stored turn diagnostics, **Then** they can see that the
   workspace policy disabled support-based replacement for that turn.

### Edge Cases

- What happens when existing workspaces have no explicit answer-support policy
  saved yet?
- What happens when an older client omits the new policy field while saving
  other retrieval settings?
- How does the system behave when no relevant contexts were retrieved and the
  existing no-context refusal path is used?
- What happens when an answer contains both supported and unsupported segments
  under `warn`, including supported citations and unsupported factual claims in
  the same response?
- How does the system handle anonymous/public chat requests for a workspace
  whose policy is not the default `strict` mode?
- What happens when the system cannot generate a localized unsupported-part
  notice for a `strict` answer?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in
  React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before
  implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example`
  MUST be updated.
- Customer data MUST be protected with least-privilege access and secure
  transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration,
  domain logic, and persistence.
- Specs MUST identify files or modules that should remain
  responsibility-limited rather than absorb new concerns.
- Backend API contracts MUST remain code-first and any HTTP contract change must
  regenerate generated OpenAPI artifacts instead of hand-editing them.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Retrieval settings routes and presenters own transport and
  settings contracts, retrieval settings services and domain validation own the
  persisted workspace policy, chat orchestration owns when post-generation
  validation is invoked, and focused answer-support policy modules own the
  policy-specific decision about replacement versus preservation.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts`
  MUST remain orchestration-only. `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
  MUST remain a presentation container rather than owning grounding policy
  semantics. Existing validator modules MUST remain responsible for support
  detection rather than becoming settings repositories.
- **New Seams Required**: Introduce a focused answer-support policy
  representation that can be stored with retrieval settings, and a focused
  policy-application seam that maps `strict`, `warn`, and `off` to answer
  handling outcomes without duplicating validation logic.
- **Anti-Goals**: Do not change the underlying support-detection heuristics in
  this feature. Do not add per-user or per-conversation overrides. Do not hide
  the active policy from diagnostics. Do not push answer-support policy logic
  into route handlers, chat history presenters, or frontend-only state. Do not
  rely on a single hard-coded English replacement notice as the primary strict
  behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow each workspace to store one answer-support
  policy as part of retrieval settings.
- **FR-002**: The supported answer-support policy values MUST be `strict`,
  `warn`, and `off`.
- **FR-003**: The system MUST expose the answer-support policy through the
  authenticated retrieval settings API and persist it per workspace.
- **FR-004**: The system MUST present the answer-support policy in the retrieval
  settings UI using operator-friendly language that explains the behavior of
  each mode.
- **FR-005**: Existing workspaces that do not yet have an explicit policy saved
  MUST default to `strict`.
- **FR-006**: Older clients that omit the new policy field while saving
  retrieval settings MUST continue to receive a usable default without breaking
  existing settings behavior.
- **FR-007**: When the workspace policy is `strict`, retrieval-backed answers
  with unsupported substantive segments MUST replace unsupported content before
  final delivery and persistence with a short generated non-verification notice
  that matches the user’s language.
- **FR-008**: When the workspace policy is `warn`, retrieval-backed answers
  with unsupported substantive segments MUST preserve the answer text while
  still recording that unsupported content was detected.
- **FR-009**: When the workspace policy is `off`, the system MUST not apply
  post-generation support replacement to retrieval-backed answers for that
  workspace.
- **FR-010**: Anonymous and public chat flows MUST apply the same workspace
  answer-support policy as authenticated chat flows in that workspace.
- **FR-011**: The existing no-context refusal path MUST remain available and
  MUST NOT be misclassified as a configurable answer-support policy outcome.
- **FR-012**: Stored turn diagnostics MUST record whether support validation
  ran, which answer-support policy was active, whether the delivered answer was
  modified, and how many segments were marked unsupported when applicable.
- **FR-013**: The feature MUST preserve enough stored diagnostics for operators
  to distinguish retrieval quality problems from policy-driven answer handling
  outcomes.
- **FR-014**: The generated non-verification notice used by `strict` MUST be
  constrained to uncertainty or non-verification wording and MUST NOT introduce
  new factual claims beyond saying the content could not be verified.
- **FR-015**: The generated non-verification notice used by `strict` MUST be
  based only on bounded inputs needed to express the unsupported scope, such as
  the unsupported segment and user-language context, rather than re-answering
  the user’s question.
- **FR-016**: If strict-mode notice generation fails or yields unusable output,
  the system MUST fall back safely to a generic non-verification notice rather
  than emitting unsupported substantive content.
- **FR-017**: The feature MUST include automated coverage for `strict`, `warn`,
  and `off` behavior on retrieval-backed answers with unsupported content.
- **FR-018**: The feature MUST preserve compatibility for existing retrieval
  settings records and existing chat history/debug views.

### UI Tasks

- The retrieval settings screen must explain that answer-support policy controls
  what happens after unsupported answer content is detected.
- The retrieval settings screen must let admins choose among `strict`, `warn`,
  and `off`.
- The retrieval settings screen must clearly explain the tradeoff between trust
  protection and preserving the model’s original answer text.
- The retrieval settings screen must explain that `strict` replaces unsupported
  content with a generated non-verification notice in the user’s language,
  rather than a generic fixed fallback in normal operation.
- The retrieval settings screen must preserve the existing retrieval and
  citation controls alongside the new answer-support policy.
- Chat history and debug views must continue to surface whether validation ran,
  whether the answer was modified, and which policy applied.

### Key Entities *(include if feature involves data)*

- **Answer Support Policy**: The workspace-scoped setting that determines how
  retrieval-backed answers are handled after unsupported segments are detected.
- **Validated Answer Outcome**: The final delivered and persisted answer
  behavior under the active policy, including whether unsupported content was
  replaced with a generated non-verification notice, preserved with
  warning-level diagnostics, or left untouched.
- **Answer Validation Diagnostics**: The stored turn-level metadata that records
  validation execution, unsupported segment counts, answer modification state,
  and the active workspace policy.

## Assumptions

- The current support-detection and unsupported-segment classification logic is
  sufficient for this feature; only the policy applied after detection is being
  made configurable.
- The generated strict-mode replacement notice can be produced from bounded
  inputs without requiring the system to re-answer the full question.
- `strict` remains the safe default for all existing and newly created
  workspaces unless an admin explicitly changes the setting.
- The setting belongs in the existing retrieval settings surface because it is a
  workspace-level grounding behavior rather than a personal preference.
- Anonymous/public chat should follow the same workspace policy as authenticated
  chat so the workspace has one coherent answer-grounding behavior.
- Existing diagnostics surfaces can be extended additively rather than replaced.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In regression coverage for this feature, 100% of retrieval-backed
  answers with unsupported substantive content follow the configured `strict`,
  `warn`, or `off` behavior.
- **SC-002**: In regression coverage for this feature, 100% of strict-mode
  replacements use a non-verification notice that does not introduce new
  unsupported factual content.
- **SC-003**: In regression coverage for this feature, 100% of workspaces that
  save an answer-support policy through the settings API or UI receive the same
  value on later retrieval-settings reads.
- **SC-004**: In regression coverage for this feature, 100% of existing
  workspaces without the new field continue to behave as `strict` without
  contract failures.
- **SC-005**: In stored-turn diagnostic inspection for each mode, operators can
  identify the active answer-support policy, whether validation ran, and whether
  the answer was modified.
- **SC-006**: In regression coverage for this feature, authenticated and
  anonymous/public chat flows in the same workspace apply the same configured
  answer-support policy.
