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

It knows nothing about chat turns, routines, contact requests, decisions or handoffs. The
published contract (event types, versions, `data` schemas, the `WorkspaceEventRecorder` port and
the `WorkspaceEventLogStore` port) lives in `backend/src/shared/domain/workspaceEventLog.ts`,
because two of its writers sit in `db/repositories`. Each owning module builds its events from
its own facts:

| Type | Built by |
|---|---|
| `conversation.started` | `db/repositories/conversationRepository.ts` (every insert method) |
| `contact_request.created`, `decision.pending`, `routine.completed` | `modules/chat/services/workspaceEventLogDrafts.ts`, recorded in the turn's transaction by `modules/chat/infra/turnOutboxWrites.ts`, and by `ContactRequestRecordingOutbox` for a notify step |
| `handoff.requested` | `modules/conversationActivity/workspaceEventLogBridge.ts`, beside every `handoff_requested` activity |

`app/composition/workspaceEventLog.ts` is the one seam: it owns the recorder and the bridged
activity recorder, and every construction that records an event is handed them from there.
The Postgres side is `db/repositories/workspaceEventLogRepository.ts`: the stateless recorder,
the snapshot read, the 30-day retention rule and the consent withholder, which removes a
withdrawn routine's events by structure (routine id, slot keys) as well as by value.

## Adding an event type

1. Add the type, its version and its `data` schema to `shared/domain/workspaceEventLog.ts`.
2. Give it a read permission in `readPermissions.ts`, no wider than where its facts are read today.
3. Record it from the owning module, in the transaction of the change, through the recorder the
   composition hands it, with an idempotency key that names the fact when the same fact can be
   written twice.
4. Regenerate the OpenAPI document and the SDK snapshot, and document the type on
   `docs-portal/content/api/workspace-event-log.mdx`.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/workspaceEventLog tests/contract/workspace-event-log.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/workspace-event-log.integration.test.ts --no-file-parallelism`
