# Workspace Event Log

The workspace event log (#1851): business events an automation acts on, recorded in the
transaction of the change they describe and listed by a cursor that never passes a row still
being committed. `specs/957-workspace-events/spec.md` holds the design. Its HTTP route is
`GET /api/v1/workspace/events`; the dashboard's `GET /api/v1/events` stream is a different
surface (realtime invalidations).

## Boundaries

This module knows:

- which permission reads each event type (`readPermissions.ts`), matched to who may see the same
  facts elsewhere: history for conversation events, and the takeover permission the Inbox's
  decisions need for `decision.pending`, which is a notification an API token cannot act on;
- the cursor (`cursor.ts`): a (transaction id, position) place in the log, range-checked, the type
  filter it was issued for, and its 29-day lifetime, counted from the event a full page ends at or
  from the read that issued a cursor at the horizon;
- how a page is served (`eventLog.ts`): the newest events when a client starts, what followed
  after that, and a cursor that moves to the snapshot horizon when a page is short.

It knows nothing about chat turns, routines, contact requests, decisions, handoffs or document
processing. The
published contract (event types, versions, `data` schemas, the `WorkspaceEventRecorder` port and
the `WorkspaceEventLogStore` port) lives in `backend/src/shared/domain/workspaceEventLog.ts`,
because three of its writers sit in `db/repositories`. Each owning module builds its events from
its own facts:

| Type | Built by |
|---|---|
| `conversation.started` | `db/repositories/conversationRepository.ts` (every insert method) |
| `contact_request.created`, `decision.pending`, `routine.completed` | `modules/chat/services/workspaceEventLogDrafts.ts`, recorded in the turn's transaction by `modules/chat/infra/turnOutboxWrites.ts`, and by `ContactRequestRecordingOutbox` for a notify step |
| `handoff.requested` | `modules/conversationActivity/workspaceEventLogBridge.ts`, beside every `handoff_requested` activity |
| `document.processed`, `document.failed` | `modules/documents/services/documentWorkspaceEvents.ts`, recorded by the job's fenced terminal write in `db/repositories/documentProcessingJobOutcomes.ts` |
| `context_value.changed` | `modules/context-variables/contextValueChangedEvent.ts`, recorded by every write or delete of a conversation's value in `db/repositories/contextVariableValueWrites.ts` |

`app/composition/workspaceEventLog.ts` is the one seam: it owns the recorder and the bridged
activity recorder, and every construction that records an event is handed them from there.
The Postgres side is `db/repositories/workspaceEventLogRepository.ts`: the stateless recorder,
the document event eraser that deleting documents calls (a title can name a person), the snapshot
read, the 30-day retention rule and the consent withholder, which removes a withdrawn routine's
events (its `routine.completed` and the `context_value.changed` it wrote) by structure (routine id,
slot keys) as well as by value.

## Subscriptions and delivery (#1852)

A subscription is a URL an automation client registered to receive the log's events as signed
POSTs. This module knows:

- the subscription lifecycle (`subscriptionService.ts`): a type is subscribed only by a caller who
  may read it from the log, the target passes the outbound URL rule
  (`normalizeWebhookTargetUrl`) and carries no userinfo, the URL and secret are sealed
  (`subscriptionSecrets.ts`), a workspace holds at most 25, and subscribing a URL again replaces
  its subscription with a new id (matched by a keyed hash of the URL; an active one's cursor carries over); the view (`subscriptionView.ts`, published
  as `EventSubscription`) shows the target's host, never its URL;
- delivery (`deliveryDrain.ts`): up to ten of one subscription's events per run, in log order,
  read through the `WorkspaceEventLogStore`, one signed POST each, after `EventSubscriptionOwnerCheck`
  (`ownerCheck.ts`) confirms the creator may still read them; `2xx` advances the cursor, `410`
  deletes the subscription, anything else records a failure and backs off with newer events behind
  it;
- the retry policy (`deliveryPolicy.ts`): `min(30 s × 2^(n−1), 1 h)`, disabled after 24 h of
  failures with at least five tries;
- the job and the sweep (`deliveryJob.ts`): one `workspace_events.deliver` job per subscription,
  level-triggered, and the scheduler that starts every due drain (the periodic sweep) or one
  workspace's (the post-commit wake).

It knows nothing about how credentials are stored or roles resolved (the owner check is a port
the composition adapts from machine access and account access), nor which change recorded an
event. The subscription store ports (lifecycle and delivery) and the wake port live in
`backend/src/shared/domain/workspaceEventSubscriptions.ts`; the Postgres store is
`db/repositories/workspaceEventSubscriptionRepository.ts`. `app/composition/workspaceEventLog.ts`
builds the service, the drain's job handler, the every-minute `workspace-event-delivery`
periodic task, and the wake the chat turn's persistence and the document worker fire after commit.

## Adding an event type

1. Add the type, its version and its `data` schema to `shared/domain/workspaceEventLog.ts`.
2. Give it a read permission in `readPermissions.ts`, no wider than where its facts are read today.
3. Record it from the owning module, in the transaction of the change, through the recorder the
   composition hands it, with an idempotency key that names the fact when the same fact can be
   written twice.
4. Regenerate the OpenAPI document and the SDK snapshot, and document the type on
   `docs-portal/content/api/workspace-event-log.mdx`.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/workspaceEventLog tests/contract/workspace-event-log.contract.test.ts tests/contract/workspace-event-subscriptions.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/workspace-event-log.integration.test.ts tests/integration/workspace-event-subscriptions.integration.test.ts tests/integration/document-workspace-events.integration.test.ts --no-file-parallelism`
