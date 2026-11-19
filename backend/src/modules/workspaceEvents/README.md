# Workspace Events

The workspace event log (#1851): business events an automation acts on, recorded in the
transaction of the change they describe and listed by a cursor that never passes a row still
being committed. `specs/957-workspace-events/spec.md` holds the design.

## Boundaries

This module knows:

- which permission reads each event type (`readPermissions.ts`), matched to where the same facts
  are read elsewhere: history for conversation events, and the decision list's takeover
  permission for `decision.pending`;
- the cursor (`cursor.ts`): a (transaction id, position) place in the log, the type filter it was
  issued for, and its 29-day lifetime;
- how a page is served (`eventLog.ts`): the newest events when a client starts, what followed
  after that, and a cursor that moves to the snapshot horizon when a page is short.

It knows nothing about chat turns, routines, contact requests, decisions or handoffs. The
published contract (event types, versions, `data` schemas, the `WorkspaceEventRecorder` port)
lives in `backend/src/shared/domain/workspaceEvents.ts`, because two of its writers sit in
`db/repositories`. Each owning module builds its events from its own facts:

| Type | Built by |
|---|---|
| `conversation.started` | `db/repositories/conversationRepository.ts` (every insert method) |
| `contact_request.created`, `decision.pending`, `routine.completed` | `modules/chat/services/workspaceEventDrafts.ts`, recorded in the turn's transaction by `modules/chat/infra/turnOutboxWrites.ts`, and by `ContactRequestRecordingOutbox` for a notify step |
| `handoff.requested` | `modules/conversationActivity/workspaceEventBridge.ts`, beside every `handoff_requested` activity |

The Postgres side is `db/repositories/workspaceEventRepository.ts`: the stateless recorder, the
snapshot read, the 30-day retention rule and the consent withholder.
`app/composition/workspaceEvents.ts` builds the log; the retention rule and the withholder are
registered with their peers in `conversationRetention.ts` and `consentWithdrawal.ts`.

## Adding an event type

1. Add the type, its version and its `data` schema to `shared/domain/workspaceEvents.ts`.
2. Give it a read permission in `readPermissions.ts`, no wider than where its facts are read today.
3. Record it from the owning module, in the transaction of the change, with an idempotency key
   that names the fact when the same fact can be written twice.
4. Regenerate the OpenAPI document and the SDK snapshot, and document the type on
   `docs-portal/content/api/workspace-events.mdx`.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/workspaceEvents tests/contract/workspace-events.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/workspace-event-log.integration.test.ts --no-file-parallelism`
