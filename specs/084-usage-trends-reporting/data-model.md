# Data Model: Usage Trends Reporting

## UsageTrendQuery

Represents the validated request.

- `accountId`: session account UUID.
- `userId`: session user UUID.
- `from`: inclusive UTC date string, `YYYY-MM-DD`.
- `to`: inclusive UTC date string, `YYYY-MM-DD`.
- `granularity`: `day | week | month`.
- `workspaceId`: optional account-owned workspace UUID.
- `agentId`: optional account-owned agent UUID.

Validation:

- `from` and `to` must be valid UTC calendar dates.
- `from` must be less than or equal to `to`.
- Generated bucket count must be at most 366.
- `workspaceId`, when present, must belong to `accountId`.
- `agentId`, when present, must belong to `accountId`.

## UsageTrendBucket

One UTC bucket in the response.

- `periodStart`: ISO timestamp at the bucket start.
- `periodEnd`: ISO timestamp at the exclusive bucket end.
- `conversationsCreated`: non-negative integer.
- `messages.total`: non-negative integer.
- `messages.user`: non-negative integer.
- `messages.assistant`: non-negative integer.
- `tokens.input`: non-negative integer.
- `tokens.output`: non-negative integer.
- `tokens.total`: non-negative integer.

Rules:

- Buckets are continuous between `from` and `to`.
- Empty periods are present with zero values.
- Message total is the sum of counted user and assistant messages.

## UsageTrendsResponse

The endpoint response.

- `granularity`: `day | week | month`.
- `from`: request `from`.
- `to`: request `to`.
- `filters.workspaceId`: UUID or null.
- `filters.agentId`: UUID or null.
- `buckets`: ordered array of `UsageTrendBucket`.

Security:

- Contains only counts and token aggregates.
- Does not include message content, prompts, completions, retrieved chunks, document content, credentials, cookies, or connection strings.

## Source Rows

No new persisted entities are introduced.

- `conversations`: count rows by `created_at`; scope through `workspaces.account_id`; filter directly by `workspace_id` and `agent_id`.
- `messages`: count rows by `created_at`; scope by `messages.workspace_id` joined to `workspaces`; filter agent through `conversations.agent_id`.
- `usage_events`: sum token columns by `occurred_at`; scope directly by `usage_events.account_id`; filter workspace directly by `workspace_id`; filter agent through `conversations.agent_id`; include only `status = 'succeeded'`.
