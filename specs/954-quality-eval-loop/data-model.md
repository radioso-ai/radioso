# Data Model: Quality Resolution and Eval Learning Loop

## Quality triage record

One current row per workspace/assistant message.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | FK workspace, tenant scope |
| assistant_message_id | UUID | FK message, composite primary key |
| state | text | open, acknowledged, resolved, dismissed |
| version | integer | positive on persisted rows; implicit absent record is 0 |
| resolution_reason | text nullable | state-compatible typed code |
| resolution_note | text nullable | trimmed, at most 500 chars; never audit/log metadata |
| reason | text nullable | deprecated compatibility text |
| closed_at | timestamptz nullable | latest accepted terminal transition |
| updated_by | UUID nullable | FK user, set null on user deletion |
| updated_at | timestamptz | display timestamp |

Terminal writes may omit a structured resolution. When supplied, the reason
must match the terminal state; `other` requires a note while other API clients
may still supply one. Active writes clear resolution and `closed_at`.
Reasonless, historical, or compatibility terminal rows are presented as
unspecified.

```text
implicit open@0 -> any accepted state@1
current state@N -> any accepted state@(N+1)
terminal@N -> open@(N+1), clearing current resolution
stale expected version -> no write, current row returned
```

## Triage transition audit

Append-only row for each accepted transition.

| Field | Type | Rules |
|---|---|---|
| id | UUID | primary key |
| workspace_id | UUID | tenant scope |
| assistant_message_id | UUID | source turn |
| prior_state / next_state | text | accepted transition |
| resulting_version | integer | unique per triage record |
| actor_id | UUID nullable | set null if actor removed |
| resolution_reason | text nullable | typed reason only |
| linked_eval_case_id | UUID nullable | Eval association visible at acceptance |
| created_at | timestamptz | immutable |

The note is intentionally absent.

## Eval message association

One current association for an assistant message.

| Field | Type | Rules |
|---|---|---|
| workspace_id | UUID | tenant scope |
| assistant_message_id | UUID | primary association identity; cascade on source deletion |
| case_id | UUID | unique FK; cascade when case is deleted |
| created_by | UUID nullable | operator/API caller |
| created_at | timestamptz | immutable |

Snapshots remain immutable and independently recapturable. Deleting a case
removes the association; adding the source message later creates a new snapshot,
case, and association.

## Quality verification projection

Read-only, not persisted in Quality:

```ts
{
  caseId: string
  caseStatus: "pending" | "passing" | "failing" | "error"
  latestRunStatus: "pass" | "fail" | "error" | "recorded" | null
  latestRunAt: string | null
}
```

## Resolution breakdown

Windowed aggregate over current triage:

```ts
{
  state: "resolved" | "dismissed"
  reason: QualityResolutionReason | "unspecified"
  count: number
}
```

It uses `closed_at`, workspace/agent/channel scope, and the same current-turn
population as the Quality list.
