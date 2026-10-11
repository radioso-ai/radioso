# Research: Notification Email Caps And Hygiene

## Decision: Delivery admission owns durable counting

**Rationale**: Both direct `contact.send` and routine-ending/approval notification sinks converge at delivery after recipients are resolved. A dedicated operator-notification guard can count actual requested recipient fan-out, apply the plan-resolved limit, make an idempotent decision per action request, and leave queue payloads unchanged.

**Alternatives considered**: Counting chat turns does not measure email fan-out. Counting only notify-skill enqueue misses direct contact and ending notices. Provider responses are too late to stop a burst and cannot safely distinguish accepted messages after network failures.

## Decision: Usage policy resolves limits; OSS persistence enforces them

**Rationale**: The existing usage-limit policy is the composition seam already replaced by EE. Adding a bounded daily-limit read lets OSS provide a finite default and EE resolve a plan number without any OSS import of the plan catalog. A shared OSS repository remains the authoritative concurrent counter in every edition.

**Alternatives considered**: Implementing all counting in EE leaves self-hosting unbounded. Putting plan imports in OSS violates dependency direction. Adding notification methods to every existing reservation fake would create broad test churn, so the new read is optional with a shared default resolver.

## Decision: One atomic fan-out decision

**Rationale**: A destination list represents one operator-authored delivery. Admitting some recipients and skipping others produces surprising partial notifications and complicates retries. The guard reserves the whole requested count or skips the email branch; webhooks remain independent when only the daily email cap is reached.

**Alternatives considered**: Per-recipient reservation maximizes use of the last few units but creates address-order bias and partial delivery.

## Decision: New conditional recipient permission

**Rationale**: Members retain ordinary agent authoring while a dedicated `workspace.notification_recipients.manage` permission is owner/admin only. HTTP and operator-tool paths check it only when a normalized recipient list is authored.

**Alternatives considered**: Removing `workspace.agents.manage` from members would overrestrict unrelated work. Route-only role checks leave Ray/MCP and reviewed proposals inconsistent.

## Decision: Audit normalized hashes, not addresses

**Rationale**: SHA-256 hashes of trimmed lowercase addresses let operators correlate safe changes while keeping addresses out of logs and metrics. Counts show list size changes without personal data.

**Alternatives considered**: Raw addresses conflict with the issue's observability requirement and audit events are logged by the shared audit service.

## Decision: Reuse the URL-as-secret webhook contract

**Rationale**: Contact delivery stores only a URL and documentation already treats it as a shared secret. Passing the exact configured URL to `createSignedWebhookHeaders` adds authentication without changing the public request schema or requiring a migration of existing settings.

**Alternatives considered**: A new stored secret improves separation but expands the public authoring contract and creates rotation/migration work beyond this slice.

## Message-Queue Impact Review

No action type, queue payload, AMQP contract, retry schedule, or worker-dispatch contract changes. Admission uses existing outbox request/workspace/conversation identities at drain time. A retry reuses the stored decision for that request.

## Observability Review

Cap decisions introduce a new skip/degradation path. The implementation persists one low-cardinality outcome per request, emits a safe audit event only for a newly recorded skip, and logs workspace/conversation/request identifiers plus bounded reason/count fields. It emits no raw recipient, webhook URL, visitor text, prompt, or completion. No metric is required in this slice because the persisted outcome and audit event provide operator/support diagnosis without adding an unbounded label surface.

## Copilot Coverage

No new operator setting or command is introduced, so no new descriptor is needed. Existing agent-setting and skill-configuration proposal tools receive conditional recipient permission checks and reviewed-apply authorization consistent with the HTTP mutations.
