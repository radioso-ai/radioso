# US3 Contract — Proposal-card mutations

Fixed contract extending `us1-api-contract.md` and
`us15-ambient-context-and-us2.md`. Spec anchors: US3 acceptance scenarios,
D5 (initial targets: directive create/update + per-agent setting change),
D6 (per-target adapters), FR-010..FR-013. The copilot NEVER writes
configuration inside the tool loop; writes happen only in the
operator-initiated apply endpoint.

## 1. Proposal entity (persisted, copilot-owned)

`copilot_proposals` (new migration; next free number):

| column | notes |
|---|---|
| id uuid | |
| workspace_id, operator_user_id | scoping identical to copilot conversations |
| conversation_id, message_id | the copilot message the card belongs to; message_id set when the turn persists |
| target_type | `"directive" \| "agent_setting"` |
| target_ref jsonb | directive: `{agentId, directiveId\|null}` (null = create); setting: `{agentId, settingKey}` |
| payload jsonb | the proposed content (directive draft / new setting value) |
| version_token text | opaque, produced by the target adapter at draft time |
| status | `"pending" \| "applied" \| "dismissed" \| "failed" \| "stale"` |
| applied_ref jsonb null | e.g. `{directiveId}` once applied |
| created_at, updated_at | |

## 2. Proposal adapter port (backend seam, D6)

Each target type contributes an adapter to the copilot module (composition
injects; copilot owns the port):

```ts
interface CopilotProposalAdapter {
  targetType: "directive" | "agent_setting";
  readVersionToken(workspaceId, targetRef): Promise<string>;
  preview(workspaceId, targetRef, payload): Promise<{ targetLabel: string; current: unknown | null; proposed: unknown }>;
  applyIfVersionMatches(workspaceId, targetRef, payload, versionToken):
    Promise<{ outcome: "applied"; appliedRef: unknown } | { outcome: "stale" } | { outcome: "failed"; reason: string }>;
}
```

- Directive adapter wraps the existing authored-directive service (create and
  update); drafting content comes from the existing directive coach service —
  no new drafting prompt.
- Agent-setting adapter wraps the agent management service; the payload is
  composed by the copilot and validated by the existing settings schemas
  before a proposal is created (invalid payload = tool error, no proposal).
- Version tokens are opaque strings derived from the target's updated-at (or
  revision where one exists). Apply compares tokens inside the adapter.

## 3. Mutation tools (turn loop, draft-only)

Two new catalog tools, both requiring `workspace.agents.manage` (absent from
the catalog for read-only principals per FR-006):

| tool | UI label | behavior |
|---|---|---|
| `propose_directive` | "Drafting a directive" | input `{agentId?, directiveId?, intent: string}`; drafts via directive coach, creates a pending proposal, returns `{proposalId, summary}` |
| `propose_agent_setting` | "Drafting a setting change" | input `{agentId?, settingKey, value, rationale?}`; validates, creates a pending proposal, returns `{proposalId, summary}` |

Both resolve `agentId` from page context like the readers. Tool output back
to the model is the proposal summary only, never a claim that anything was
applied. Add both to `catalogCoverage.ts`.

## 4. SSE + persistence surface

- New SSE event during turns: `proposal` —
  `{ "proposalId": "uuid", "targetType": "directive|agent_setting", "targetLabel": "string", "summary": "string" }`,
  emitted after the tool call that created it; ordering rules from US1 gain
  `proposal` in the "any mix" phase.
- `GET /copilot/conversations/:id` copilot messages gain
  `proposals: [{ id, targetType, targetLabel, summary, status }]`.

## 5. Proposal endpoints (session-only, same guards as the copilot routes)

| endpoint | permission | behavior |
|---|---|---|
| `GET /api/v1/copilot/proposals/:proposalId` | `workspace.agents.read` | full card data: target, label, status, `preview` (current/proposed from the adapter), staleness recheck (`currentVersionMatches: boolean`) |
| `POST /api/v1/copilot/proposals/:proposalId/apply` | `workspace.agents.manage` | runs `applyIfVersionMatches`; persists outcome (`applied`/`stale`/`failed`); 200 with `{status, appliedRef?}`; applying a non-pending proposal → 409 |
| `POST /api/v1/copilot/proposals/:proposalId/dismiss` | `workspace.agents.read` (own proposal) | pending → dismissed; 409 otherwise |

Audit events: `copilot.proposal.created`, `.applied`, `.dismissed`, plus
`.apply_failed` with outcome `stale|failed`. No payload content in audit
metadata — ids, target type, and outcome only.

## 6. Frontend (luna scope)

- Proposal card rendered in the chat thread (live from the `proposal` SSE
  event; persisted from message `proposals`): target label, summary, and an
  expandable diff (fetched from `GET /proposals/:id` — render `current` vs
  `proposed` as a compact field-level diff; create = all-new).
- Actions: **Apply** (only when the account holds `workspace.agents.manage`;
  hidden otherwise) and **Dismiss**, with confirm on apply. Applied cards show
  the applied state and link to the target entity (reuse entity-chip
  navigation); stale cards explain the target changed since drafting and
  suggest re-asking; failed cards show the reason.
- The system prompt's capability list changes (backend): the copilot CAN
  draft configuration changes as proposals the operator reviews and applies;
  it still cannot write directly. Suggested-question chips may include a
  draft suggestion when an agent is in context.
- Docs page updated (proposals section: what they are, who can apply,
  staleness).

## 7. Out of scope for US3

Routine and document proposals (deferred per D5), bulk apply, proposal
editing before apply (dismiss and re-ask instead), MCP exposure.
