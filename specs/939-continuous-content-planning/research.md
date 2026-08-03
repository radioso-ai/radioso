# Research: Audience Pulse v1

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Product boundary | A distinct `modules/audiencePulse`, mounted under the Quality URL namespace | It shares operator navigation/permission vocabulary but represents visitor interests, not Quality's assistant-turn triage. |
| Authorization | New cookie-only `requireDashboardWorkspaceSession` | `requireWorkspaceSession` correctly supports bearer fallback elsewhere. Rejecting its `authMode` afterward is too late. |
| Population | One UTC `[analysisStart, analysisEnd)` interval; customer user messages in end-user channels; `(created_at,id)` order | It yields reproducible totals and excludes dashboard test chat/replay. Pair only a subsequent AI assistant message before `analysisEnd` and before the next user turn. |
| Gap rule | Pure typed helper | Qualify only `retrieval.answer:no_context` + `no_support`, and `retrieval.answer:grounded_degraded` + `degraded`; all other states remain discussion evidence but cannot become gaps. |
| Sampling | Deterministic UTC-week/channel strata; max 80 questions, 60 conversations, 32,000 characters, and 3 questions/conversation | It preserves breadth while bounding a single model request. Within a stratum, select `(created_at,id)` deterministically, allocating round-robin across strata until a cap applies. |
| Inference | One workspace chat-capability `ModelInferencePipeline.complete` call with JSON schema/Zod | It reuses configured provider/client cache, enforces structured output, and binds an `audience_pulse.analysis` usage context without tools. |
| Snapshot privacy | Persist full prompt-evidence opaque references; rehydrate all on GET; conditionally invalidate the revision read | Model prose can derive from omitted prompt evidence. A revision condition prevents a stale GET from deleting a concurrently refreshed snapshot. |
| Concurrent refresh | Database-backed session advisory lease on one pinned Kysely connection | It prevents duplicate provider work across replicas; `finally` releases it and connection loss releases it after a crash. |
| Cost control | Durable `audience_pulse.refresh` rate scope, default 3/15 minutes per account/workspace; existing answer usage reservation only around provider work | The general 60/minute expensive-route limit is too high. No traffic uses neither provider nor reservation; snapshot save decides commit. |
| Error outcomes | 409 `busy`; 429 rate-limited or usage-limited; typed unavailable only for inference/validation/cancellation | The dashboard can present a clear retry-later/capacity state instead of misleading provider-failure copy. |
| Document handoff | Account/workspace-keyed `sessionStorage` intent | It maps suggestion title to `title` and questions to Markdown `content`, avoids URL exposure, and preserves Documents as the sole writer. |
| MCP | Internal Zod/JSON read + refresh port; no MCP registration | A future Copilot can adapt only read as `audience_pulse.read`; refresh remains dashboard controlled. |
| Queue impact | None | This is a synchronous demand-driven operation; no worker, AMQP payload, retry, or queue docs change. |

## Alternatives Rejected

- Reusing Quality's turn query/service: its AI-turn triage population is a different
  domain and would make a Quality surface own content-planning policy.
- An in-memory mutex: application replicas could duplicate a provider request.
- Any `no_support`/`degraded` diagnostic as a gap: it loses the typed distinction between
  missing content, correct out-of-scope declines, and unavailable generation.
- Partial snapshot redaction: summary/theme prose may still derive from a deleted prompt
  item.
- A generic deletion bus, trigger, worker, or scheduled runner: no v1 value beyond the
  mandatory read-time privacy guarantee.
- Draft data in a URL: customer-derived recommendation text would leak into browser
  history, logs, and sharing surfaces.

## Refresh policy

The `audience_pulse.refresh` scope has a code-owned budget of three explicit refresh
attempts per account and workspace every 15 minutes. It is product policy, not an
operator environment setting.
