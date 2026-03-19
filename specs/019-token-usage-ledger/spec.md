# Feature Specification: Model Token Usage Tracking & Account Summaries

**Feature Branch**: `019-token-usage-ledger`
**Created**: 2026-03-19
**Status**: Draft
**Input**: User description: "I need to start tracking token usage and record it with every message, also in the debug UI in history. Can we also somehow summarize daily and monthly token usage on the account level?"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect Token Usage Per Chat Turn (Priority: P1)

An operator opens chat history, selects a conversation, and expands the debug metadata for an assistant response. They can see the total usage attributable to that chat turn plus a breakdown of the model-backed steps that produced it, including rewrite, query embedding, rerank, and answer generation when those steps ran.

**Why this priority**: Per-turn visibility is the primary operator need. Without it, users cannot understand which messages consumed tokens or verify that the system is tracking usage correctly.

**Independent Test**: Can be fully tested by completing a chat turn, opening history, and verifying the assistant turn shows attributable usage totals and operation-level details.

**Acceptance Scenarios**:

1. **Given** a new chat turn completes successfully, **When** an operator opens that conversation in history, **Then** the assistant turn's debug view shows the attributable token totals for that turn and the contributing operations.
2. **Given** a chat turn streams its final answer, **When** the conversation is opened in history after completion, **Then** the same usage details are available as for non-streaming turns.
3. **Given** one of the model-backed steps in a chat turn does not return usage values, **When** the operator inspects the turn, **Then** the UI shows that usage is unavailable for that step instead of silently treating it as zero.

---

### User Story 2 - Review Account Usage from the Account Menu (Priority: P2)

An account owner opens Usage from the bottom-left account menu and reviews how many tokens the account has consumed today, across recent days, and across recent months, regardless of which workspace generated the activity.

**Why this priority**: Account-level visibility is required for budgeting, planning, and support. Operators need a durable summary view that does not require reading individual chat turns.

**Independent Test**: Can be fully tested by generating activity in multiple workspaces, opening Usage from the account menu, and verifying the daily and monthly totals reflect the combined account activity.

**Acceptance Scenarios**:

1. **Given** an account has usage events from multiple workspaces on the same day, **When** the account owner opens Usage from the account menu, **Then** the daily total reflects the sum across those workspaces.
2. **Given** an account has usage spanning multiple calendar months, **When** the account owner views the Usage screen, **Then** the screen shows monthly totals for each month in the selected history window.
3. **Given** new usage is generated after the Usage screen was last viewed, **When** the account owner refreshes or revisits the screen, **Then** the daily and monthly totals reflect the newly recorded usage without requiring manual reconciliation.

---

### User Story 3 - Reach Usage from Any Workspace Context (Priority: P3)

An operator working inside any workspace can reach the same account-wide Usage screen from that workspace context without losing sight of which workspace they were in when they opened it.

**Why this priority**: Usage is account-level, but users work from within a workspace. The entry point must feel available from every workspace rather than hidden in a separate account-only area.

**Independent Test**: Can be fully tested by switching between workspaces, opening Usage from the account menu in each one, and verifying the same account-wide totals load.

**Acceptance Scenarios**:

1. **Given** the user is in Workspace A, **When** they open the bottom-left account menu and choose Usage, **Then** the app opens the account-wide Usage screen.
2. **Given** the user switches to Workspace B, **When** they open Usage from the same account menu, **Then** the screen still shows account-wide totals rather than only Workspace B totals.
3. **Given** the user is viewing the account-wide Usage screen, **When** they return to the main app navigation, **Then** their active workspace context remains unchanged.

---

### User Story 4 - Trust Usage Totals as Activity Grows (Priority: P4)

An operator relies on the Usage screen and history debug over time, including after retries, asynchronous document processing, and workspace deletion, and expects totals to remain accurate without the product becoming slow.

**Why this priority**: Usage tracking becomes a source of operational truth. If totals drift, double-count, or become expensive to load, the feature loses value quickly.

**Independent Test**: Can be fully tested by generating chat activity, document-processing activity, retries, and workspace deletion events, then verifying the account summaries remain accurate and continue to load promptly.

**Acceptance Scenarios**:

1. **Given** a document is processed asynchronously and generates embedding usage, **When** the account owner opens the Usage screen, **Then** that usage is included in the correct day and month totals even though it is not attached to a chat message.
2. **Given** a workspace that previously generated usage is deleted, **When** the account owner later views usage summaries for that period, **Then** the historical account totals remain unchanged.
3. **Given** daily summaries need to be rebuilt from raw usage records, **When** reconciliation is run, **Then** the rebuilt daily and monthly totals match the recorded usage history.

### Edge Cases

- Historical conversations that predate this feature must show usage as unavailable rather than displaying misleading zero values.
- A provider call may fail or return no usage payload; the system must preserve the event outcome without inflating token totals.
- A single chat turn may trigger several model-backed operations; the turn-level debug view must include all attributable usage without duplicating counts across messages.
- Retried or replayed background work must not double-apply the same usage event to account summaries.
- Deleting a workspace or conversation must not erase already-recorded account-level historical usage for prior days or months.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport routes and presenters own validation, auth, and response shaping only. Chat, retrieval, and document-processing services continue to own operation orchestration. A dedicated usage-tracking layer owns raw usage event recording and account-level rollup updates. Persistence repositories own immutable usage events and daily summary storage.
- **Encapsulation Rule**: `chatService.ts` must remain chat-turn orchestration and must not absorb rollup queries or usage SQL. `chatHistoryService.ts` must assemble conversation detail from repositories and presenters, not become the source of truth for token accounting. `settings-view.tsx` must remain presentation-only and consume account usage data through an API client rather than direct storage logic. `dependencies.ts` must remain wiring-only.
- **New Seams Required**: A focused usage-event repository, a daily account-usage summary repository, a usage summary service for account queries and reconciliation, and a reusable usage-capture seam around model gateways so chat, retrieval, and document processing do not each hand-roll token logging.
- **Anti-Goals**: Do not use `audit_events` as the only source of token accounting. Do not compute account summaries by scanning messages or raw chat history on every page load. Do not introduce a separate monthly source of truth that can drift from daily summaries. Do not let workspace-scoped API tokens expose account-wide usage across all workspaces.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST record an immutable usage event for every model-backed operation in scope, including chat answer generation, query rewrite, rerank, retrieval/query embeddings, and asynchronous document-processing embeddings.
- **FR-002**: Each usage event MUST include the owning account, originating workspace when applicable, operation type, model identifier, event timestamp, operation outcome, and the token counts returned by the provider when available.
- **FR-003**: When a provider does not return token counts, the system MUST preserve the usage event with an explicit "usage unavailable" state rather than estimating or silently substituting zero.
- **FR-004**: Usage events produced during a chat exchange MUST retain sufficient linkage to attribute them to the completed assistant turn in conversation history.
- **FR-005**: The system MUST expose turn-level usage totals and operation-level usage breakdowns in chat history debug for newly recorded assistant turns.
- **FR-006**: The system MUST store daily account-level usage summaries derived from raw usage events so that usage screens can read pre-aggregated daily totals rather than recomputing from raw history on each request.
- **FR-007**: The system MUST provide account-scoped daily and monthly usage queries that combine activity from all workspaces belonging to the account.
- **FR-008**: Monthly totals MUST be computed from stored daily summaries so the product has a single persisted rollup source of truth below the raw usage ledger.
- **FR-009**: The system MUST update daily summaries as new usage events are recorded and MUST ensure each raw event contributes to rollups at most once.
- **FR-010**: The system MUST preserve historical account usage totals even if the originating workspace, conversation, or message is later deleted through normal product flows.
- **FR-011**: The system MUST provide a dedicated account-level Usage screen for authenticated account users to review daily and monthly usage across all workspaces.
- **FR-012**: The Usage screen MUST be served through account-authenticated access and MUST NOT be exposed through workspace API tokens that can only access a single workspace's data.
- **FR-013**: The Usage screen MUST show at minimum the current day's total, a recent daily breakdown, and recent monthly totals for the account.
- **FR-014**: The bottom-left account menu MUST expose Usage as an account-level navigation item that is reachable while the user is in any workspace.
- **FR-015**: Opening Usage from a workspace context MUST preserve the user's active workspace selection when they navigate back to workspace-scoped views.
- **FR-016**: The system MUST provide a supported reconciliation path that can rebuild daily summaries from the immutable usage ledger if summaries need repair.

### UI Tasks

- Add a "Usage" item to the bottom-left account menu so the account-wide screen is reachable from any workspace.
- Add a dedicated account-level Usage screen that is visually distinct from workspace retrieval settings.
- Show account-level token summary cards for the current day and current month.
- Show a recent daily breakdown view so the account owner can inspect recent activity trends.
- Show recent monthly totals so the account owner can compare month-over-month account usage.
- Extend the chat history debug panel to display turn-level usage totals and an operation-by-operation breakdown for attributable model steps.
- Display "usage unavailable" states explicitly when a recorded operation lacks token counts.

### Key Entities

- **Usage Event**: An immutable record of a single model-backed operation. It belongs to an account, may reference a workspace, conversation, assistant turn, document, or processing job, and stores operation type, model, status, timestamp, and token counts when available.
- **Daily Usage Summary**: An account-scoped aggregate for a single calendar day that stores rolled-up token totals derived from usage events and serves as the persisted source for higher-level summaries.
- **Turn Usage Detail**: The attributable set of usage events linked to one completed assistant turn so history debug can show both the total usage for that exchange and the operation-level breakdown.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of newly completed chat turns that receive provider-reported usage values expose those values in history debug for the owning workspace.
- **SC-002**: 95% of Usage screen loads for an account with up to 12 months of retained usage history complete in under 2 seconds.
- **SC-003**: In reconciliation tests, daily and monthly account totals match the underlying usage ledger with 100% accuracy.
- **SC-004**: Newly recorded usage appears in the account's daily and monthly summaries within 1 minute of the underlying operation completing.
- **SC-005**: Historical account totals for closed periods remain unchanged after workspace deletion or conversation cleanup.

## Assumptions

- The first release is forward-looking only; historical chat turns and prior document-processing activity do not need backfilled usage events.
- The Usage screen lives in account-level navigation surfaced through the bottom-left account menu rather than inside workspace retrieval settings.
- Monthly summaries can be computed from persisted daily summaries at read time; a separate monthly materialization is not required for initial release.
- Provider-reported token counts are authoritative. When they are missing, the system records that absence instead of generating estimates.
