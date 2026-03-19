# Research: Model Token Usage Tracking & Account Summaries

**Feature**: 019-token-usage-ledger | **Date**: 2026-03-19

## Findings

### 1. Raw Ledger + Daily Rollup Strategy

- **Decision**: Store every model-backed operation in an immutable `usage_events` ledger and update an `account_daily_usage_summaries` row in the same write path.
- **Rationale**: The ledger remains the source of truth for reconciliation and turn-level debug, while daily rollups keep the account Usage screen cheap to query.
- **Alternatives considered**:
  - Query raw events for every Usage page load — rejected because it scales poorly and violates the spec's anti-goals.
  - Persist both daily and monthly rollups — rejected because monthly materialization adds a second drift-prone summary source.

### 2. Monthly Aggregation Method

- **Decision**: Compute monthly totals at read time from persisted daily summaries.
- **Rationale**: Daily rows are already small and bounded. Summing them by month is cheap, keeps one persisted rollup layer, and avoids sync problems.
- **Alternatives considered**:
  - Dedicated monthly summary table — rejected for higher sync complexity with little near-term benefit.

### 3. Preserving History After Workspace or Message Deletion

- **Decision**: Usage events store `accountId` as durable ownership and treat workspace/message/document references as optional attribution metadata that may be nulled or stored without hard foreign-key dependence.
- **Rationale**: Account history must survive normal workspace/message cleanup. Hard cascading FKs on attribution columns would erase history or complicate deletes.
- **Alternatives considered**:
  - Full FK graph with cascading deletes — rejected because it conflicts with the requirement to preserve historical totals.

### 4. Idempotent Rollup Updates

- **Decision**: Each usage event carries a unique operation key, and event insert + daily rollup update occur in one repository-level transaction. If the same operation key is seen again, the insert is ignored and the rollup is not incremented twice.
- **Rationale**: This prevents double-counting from retried persistence or replayed background work while keeping the write path deterministic.
- **Alternatives considered**:
  - Accept duplicate events and repair later — rejected because it undermines trust in the Usage screen and complicates reconciliation.

### 5. Chat-Turn Attribution Model

- **Decision**: Attribute all model-backed operations for a chat exchange to the final assistant turn via conversation/user-message/assistant-message linkage captured once the turn is finalized.
- **Rationale**: The debug UI is assistant-turn-centric today. Aggregating by assistant turn keeps the UI model intact while still counting rewrite/rerank/embedding activity that occurred before the assistant message was saved.
- **Alternatives considered**:
  - Store usage only on assistant messages — rejected because it loses operation-level detail and non-answer steps.
  - Attach usage to user messages — rejected because the current debug view is already centered on assistant turns.

### 6. Usage Capture Seams

- **Decision**: Instrument the OpenAI-facing gateway classes (`OpenAIChatGateway`, `OpenAIQueryRewriteGateway`, `OpenAISemanticRerankGateway`, `OpenAIEmbeddingGateway`) so they return normalized usage data alongside business results to the orchestration layer, which then delegates persistence to the usage service.
- **Rationale**: The provider usage payload originates at the gateway boundary. Surfacing it once avoids ad hoc parsing in higher layers and keeps SQL out of the gateways.
- **Alternatives considered**:
  - Record usage directly inside each gateway — rejected because gateways should stay integration-focused, not persistence-aware.
  - Parse usage in route handlers — rejected because routes do not see all model operations and would violate layering.

### 7. Account-Level Navigation Entry

- **Decision**: Add `usage` as a dashboard/account route section and expose it from the existing bottom-left account dropdown menu.
- **Rationale**: The user explicitly wants account-level usage reachable from any workspace via the account menu. The current route parser and dashboard shell already support adding new sections cleanly.
- **Alternatives considered**:
  - Nest Usage under workspace settings — rejected because the feature is account-wide, not workspace-scoped.
