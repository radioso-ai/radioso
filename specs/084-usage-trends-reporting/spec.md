# Feature Specification: Usage Trends Reporting

**Feature Branch**: `084-usage-trends-reporting`  
**Created**: 2026-06-09  
**Status**: Approved  
**Input**: User description: "Strengthen the visibility reporting for usage trends — how many messages, how many conversations, how many tokens consumed per period. Audience: everyone with member-and-higher access to the org. Per account, with the ability to filter by agent and workspace. Daily, weekly, monthly. Number of conversations means conversations created in the period."

**Scope Note**: This is an OSS feature (not EE-gated). It reports trends over data already owned by OSS — `conversations`, `messages`, and the `usage_events` ledger. It introduces a read-model and a member-accessible reporting surface; it does NOT introduce new usage instrumentation and does NOT change any enforcement or limit behavior. The existing EE usage-limits summary (current-period quota vs limit) is unchanged and separate from this trends view.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See Account Usage Trends Over Time (Priority: P1)

As any member (or higher) of an organization, I want to see how my account's usage has changed over time — conversations started, messages exchanged, and tokens consumed per period — so I can understand adoption and consumption without operator/admin access.

**Why this priority**: Today the only usage surface is a current-period quota summary; there is no time-series visibility into whether usage is growing, flat, or spiking, which is the core ask.

**Independent Test**: As a member of an account with activity across several days, request the trends report for a date range at daily granularity and verify it returns a per-day series of conversations created, messages, and tokens consumed for that account.

**Acceptance Scenarios**:

1. **Given** an account with conversations, messages, and recorded model usage across multiple days, **When** a member requests trends for a date range at daily granularity, **Then** the response returns, per day in range, the count of conversations created, the message volume, and the tokens consumed.
2. **Given** a date range with days that had no activity, **When** trends are requested, **Then** those days appear with zero values (a continuous series, not gaps).
3. **Given** a member of the account (not owner/admin), **When** they request trends, **Then** access is granted.
4. **Given** a user with no active membership on the account, **When** they request trends, **Then** access is denied.

---

### User Story 2 - Filter Trends by Workspace and Agent (Priority: P1)

As a member, I want to narrow the trends to a specific workspace and/or a specific agent so I can attribute usage to the surface that produced it.

**Why this priority**: Account-wide totals hide which agent or workspace drives consumption; attribution is required to act on the data.

**Independent Test**: With activity spread across two agents in one workspace, request trends filtered to one agent and verify only that agent's conversations, messages, and tokens are counted.

**Acceptance Scenarios**:

1. **Given** activity across multiple workspaces in the account, **When** trends are requested filtered to one workspace, **Then** only that workspace's activity is counted.
2. **Given** activity across multiple agents in a workspace, **When** trends are requested filtered to one agent, **Then** only that agent's conversations, messages, and tokens are counted.
3. **Given** a workspace or agent filter that does not belong to the requesting account, **When** trends are requested, **Then** the request is rejected (no cross-account leakage).
4. **Given** no filter is supplied, **When** trends are requested, **Then** the report covers the entire account.

---

### User Story 3 - Choose Daily, Weekly, or Monthly Granularity (Priority: P2)

As a member, I want to switch between daily, weekly, and monthly buckets so I can see short-term spikes or long-term trends as needed.

**Why this priority**: Different decisions need different time resolutions; a single fixed bucket is insufficient.

**Independent Test**: Request the same date range at daily, weekly, and monthly granularity and verify the buckets aggregate consistently (e.g. the sum of daily values within a week equals that week's weekly value).

**Acceptance Scenarios**:

1. **Given** a date range, **When** weekly granularity is requested, **Then** values are bucketed by UTC week and are internally consistent with the daily series over the same range.
2. **Given** a date range, **When** monthly granularity is requested, **Then** values are bucketed by UTC calendar month.
3. **Given** any granularity, **When** the report is returned, **Then** bucket boundaries are UTC and documented so the UI can label them unambiguously.

### Edge Cases

- A conversation created in the period but with no messages yet — counts toward conversations created, not toward message volume.
- Messages or usage events whose conversation has since been deleted — define whether they still count (token events reference `conversation_id` which may be `SET NULL` on conversation delete; account-scoped token totals should remain stable regardless).
- Token totals when an operation failed — define whether failed-status usage events contribute to "tokens consumed" (recommended: count succeeded operations for the customer-facing consumption figure).
- Very large date ranges at daily granularity — the API MUST bound the maximum range/number of buckets to protect the database.
- Agent filter applied to token totals — tokens attribute to an agent only through the conversation; usage events with no conversation cannot be agent-filtered and MUST be excluded from agent-filtered token totals (and this exclusion documented).
- Time zone: all bucketing is UTC; the UI is responsible for any local-time presentation.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved (Spec-First, NON-NEGOTIABLE).
- Backend development MUST follow TDD: failing tests authored before implementation (Backend TDD, NON-NEGOTIABLE).
- Backend MUST be Node.js/TypeScript; database MUST be PostgreSQL.
- The read-model MUST preserve modular boundaries: aggregation/query logic lives in a focused reporting module; the route handler stays orchestration-only; authorization reuses existing account-membership services.
- Public HTTP contract changes (the new trends endpoint) MUST update the code-first OpenAPI registry at `backend/src/app/http/openapi/document.ts` and regenerate `backend/openapi.yaml` / `backend/openapi.json`, with a message-queue impact review (expected: none).
- Documentation for the new reporting surface (operator/product docs and any settings/dashboard docs) MUST be updated in the same change.
- Frontend work MUST follow the Frontend Testing Discipline: Playwright for the user-visible trends journey; unit tests limited to data transforms/adapters/period math, not markup or styling.
- No new runtime LLM prompts; no hard-coded assistant copy.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: A dedicated OSS reporting/read-model module owns the trend aggregation queries. It MUST NOT live inside the EE usage-limits module and MUST NOT depend on EE. It reads `conversations`, `messages`, and `usage_events` (and MUST NOT write them).
- **Source-Of-Truth Rule**: Trends are derived directly from `conversations` (conversations created), `messages` (message volume), and `usage_events` (tokens). The `usage_daily_rollups` cache MUST NOT be used as the source because it lacks workspace and agent dimensions and cannot satisfy the filters; if a richer rollup is later introduced it is out of scope here.
- **Attribution Rule**: Workspace and agent filters use `conversations.workspace_id` and `conversations.agent_id` (direct), `messages.workspace_id` (direct) joined to `conversations` for agent, and `usage_events.account_id`/`workspace_id` (direct) joined to `conversations` for agent. Account scoping for `usage_events` uses its direct `account_id`; for conversations/messages it resolves through `workspaces.account_id`.
- **Authorization Rule**: The endpoint is session-authenticated and requires an active membership on the account (any role: member, admin, or owner), reusing the existing account-access service. Workspace/agent filter values MUST be validated to belong to the requesting account.
- **Encapsulation Rule**: SQL and bucketing math live in the reporting module's query helpers (a pure, testable surface), following the existing `quality` module aggregation pattern (`backend/src/modules/quality/service.ts`). The route handler validates input, calls the service, and maps the response.
- **Performance Rule**: Each bucketed aggregation MUST be backed by an index that matches its bucketing/filter timestamp, validated by `EXPLAIN ANALYZE` (no sequential scan on the source table for a bounded range), since this endpoint is member-accessible and may query large ranges. The message path (`messages_workspace_role_created_id_idx` = `workspace_id, role, created_at`) and the token path (`idx_usage_events_workspace_occurred_at`, `idx_usage_events_account_occurred_at`) already have timestamp-aligned indexes and MUST reuse them. The **conversation** path buckets by `created_at`, which the existing conversation indexes do NOT cover — they lead with `updated_at` (`idx_conversations_workspace_agent_updated_id`, 048) or are workspace-only (`idx_conversations_workspace_id`, 005). This feature therefore MUST add a `created_at`-aligned conversation index (`idx_conversations_workspace_created_at` on `conversations (workspace_id, created_at)`), chosen by EXPLAIN over a `created_at`-leading alternative because the composite keeps account-wide scans within the account's workspaces rather than reading cross-tenant rows. The API MUST also bound the requested range / bucket count.
- **Anti-Goals**: Do not gate this behind EE. Do not source filtered trends from `usage_daily_rollups`. Do not expand the route handler into a god-file with inline SQL. Do not expose raw prompts, completions, message content, or chunk text — only counts and token aggregates. Do not leak cross-account data through unvalidated filters.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a member-accessible report of account usage trends bucketed over a requested date range.
- **FR-002**: The report MUST include, per bucket: number of conversations created, message volume, and tokens consumed.
- **FR-003**: "Number of conversations" MUST count conversations whose creation time falls within the bucket (conversations created in the period).
- **FR-004**: "Message volume" MUST count messages whose creation time falls within the bucket, and MUST distinguish assistant messages from user messages (e.g. separate counts or a role breakdown).
- **FR-005**: "Tokens consumed" MUST aggregate input, output, and total tokens from the usage-event ledger for the bucket; only succeeded-status usage events contribute to the customer-facing consumption total (failed-status events are excluded — confirmed decision).
- **FR-006**: The report MUST support daily, weekly, and monthly granularity, with all bucket boundaries computed in UTC.
- **FR-007**: The report MUST return a continuous series across the requested range, emitting zero-valued buckets for periods with no activity.
- **FR-008**: The report MUST be scoped to the requesting account and MUST NOT include any other account's data.
- **FR-009**: The report MUST accept an optional workspace filter and an optional agent filter; when supplied, all three metrics MUST reflect only the filtered subset.
- **FR-010**: Workspace and agent filter values MUST be validated as belonging to the requesting account; invalid or cross-account filters MUST be rejected.
- **FR-011**: Access MUST require an active membership on the account (member, admin, or owner); users without membership MUST be denied.
- **FR-012**: The endpoint MUST bound the maximum date range and/or number of buckets returned and MUST reject or clamp requests exceeding the bound (behavior documented).
- **FR-013**: Agent-filtered token totals MUST include only usage events attributable to that agent via their conversation; usage events without a conversation MUST be excluded from agent-filtered token totals, and this MUST be documented.
- **FR-014**: The reporting output MUST NOT contain message content, prompts, completions, or chunk text — only counts and token aggregates.
- **FR-015**: The new HTTP contract MUST be reflected in the code-first OpenAPI registry and generated artifacts, and contract tests MUST cover the response shape.
- **FR-016**: A frontend trends view MUST present the series with controls for date range, granularity (daily/weekly/monthly), workspace filter, and agent filter, available to members and above.

### Key Entities *(include if feature involves data)*

- **Usage Trend Bucket**: One time bucket in the report, carrying its period start/end (UTC) and the metrics: conversations created, message volume (with role breakdown), and tokens consumed (input/output/total).
- **Trend Query Filters**: The optional `workspaceId` and `agentId` filters plus the required date range and granularity, all account-scoped.
- **Source Tables (read-only)**: `conversations` (created-in-period, workspace/agent attribution), `messages` (volume, role), `usage_events` (token aggregates, account/workspace attribution, agent via conversation join).

## Read Paths

- **Conversations created**: `conversations` filtered by the account's workspaces (and optional `workspace_id` / `agent_id`), bucketed by `date_trunc(granularity, created_at)` in UTC.
- **Message volume**: `messages` joined to `conversations` (for agent filter), scoped to the account's workspaces, bucketed by `date_trunc(granularity, created_at)`, split by `role`.
- **Tokens consumed**: `usage_events` filtered by `account_id` (and optional `workspace_id`; agent via join to `conversations.agent_id`), succeeded status, bucketed by `date_trunc(granularity, occurred_at)`, summing `input_tokens` / `output_tokens` / `total_tokens`.
- The series is zero-filled across the range so the three sources align on a shared bucket axis.

## API Direction

A new session-authenticated endpoint, account-scoped, e.g.:

```
GET /api/v1/account/usage-trends
  ?from=YYYY-MM-DD&to=YYYY-MM-DD
  &granularity=day|week|month
  &workspaceId=<uuid>        (optional)
  &agentId=<uuid>            (optional)
```

Response shape (illustrative; finalized at plan time):

```ts
{
  granularity: "day" | "week" | "month";
  from: string;            // UTC date
  to: string;              // UTC date
  filters: { workspaceId: string | null; agentId: string | null };
  buckets: Array<{
    periodStart: string;   // UTC
    periodEnd: string;     // UTC
    conversationsCreated: number;
    messages: { total: number; user: number; assistant: number };
    tokens: { input: number; output: number; total: number };
  }>;
}
```

Exact path, parameter names, and whether this is also surfaced in the TypeScript SDK are finalized at plan time. At minimum it is a dashboard/account API documented in OpenAPI.

## Assumptions

- All three metrics can be derived from existing OSS tables without new instrumentation.
- `conversations.created_at`, `messages.created_at`, and `usage_events.occurred_at` are the correct timestamps for bucketing each metric.
- Account membership (any role) is the correct authorization bar for "member and higher."
- UTC bucketing is acceptable; localization is a UI concern.
- `usage_daily_rollups` is intentionally not used here; a richer multi-dimension rollup is a possible future optimization, out of scope.
- No message-queue or worker payloads are affected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member of an account can retrieve a per-period series of conversations created, message volume, and tokens consumed for a chosen date range and granularity.
- **SC-002**: Daily, weekly, and monthly views are internally consistent — summing finer buckets over a coarser bucket's span yields the coarser bucket's totals for each metric.
- **SC-003**: Filtering by workspace and by agent narrows all three metrics to exactly that subset, verified against known seeded activity.
- **SC-004**: A non-member is denied, and a filter referencing another account's workspace or agent is rejected with no data leakage.
- **SC-005**: Days/weeks/months with no activity appear as zero-valued buckets, producing a continuous series.
- **SC-006**: Requests exceeding the configured maximum range/bucket count are rejected or clamped per the documented bound.
- **SC-007**: The reporting output contains only counts and token aggregates — no message content, prompts, completions, or chunk text.
- **SC-008**: The frontend trends view lets a member change date range, granularity, workspace, and agent and reflects the corresponding series.
