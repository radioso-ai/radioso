# Phase 1 — Data Model: HITL Tranche A (Approval MVP)

Scope: the data added/altered for US1–US3. Full contract sketches in [contracts/](./contracts/). The runtime source of truth is the engine `.d.ts`, the migrations, and `backend/src/app/http/openapi/document.ts`.

## Entities

### Pending Decision (NEW — `pending_decisions` table)

A decision a human must resolve before a suspended routine resumes. **Sibling of `routine_action_requests`, not part of it.**

| Field | Type | Notes |
|---|---|---|
| `id` | UUID PK | internal id |
| `handle` | TEXT, unique | opaque, unguessable, single-use resume token **and** correlation key — never the conversation id |
| `conversation_id` | UUID | scope/correlation |
| `session_id` | UUID | scope |
| `workspace_id` | UUID | queue scoping + authz |
| `agent_id` | UUID | authz / decider scope |
| `routine_id` | TEXT | the suspended routine |
| `step_id` | TEXT | the gated step (resume lands here) |
| `reason` | TEXT, null | why it gated (a reason, never a confidence number) |
| `options` | JSONB | `[{id,label,description?,payload?}]` — authored, model cannot redirect |
| `decider_scope` | JSONB | who may resolve, resolved server-side (e.g. `{kind:'workspace_role',role:'owner'}`) |
| `content_hash` | TEXT | canonical (sorted-key) hash binding the decision to the exact proposal |
| `status` | TEXT | `pending → approved \| rejected \| cancelled` (`timed_out`/`escalated` reserved for the future timeout phase) |
| `decision` | JSONB, null | `{optionId, payload?}` as applied |
| `decided_by` | UUID, null | resolving operator account id |
| `decided_at` | TIMESTAMPTZ, null | |
| `deadline` | TIMESTAMPTZ, null | recorded + displayed; **no automated resolution in Tranche A** |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

Indexes:
- `UNIQUE (handle)` — single-use lookup.
- `UNIQUE (conversation_id, routine_id, step_id) WHERE status='pending'` — **one open decision per gate** (DB-enforced).
- `(workspace_id, created_at) WHERE status='pending'` — queue read.
- `(deadline) WHERE status='pending'` — overdue display (and the future sweep).

**Idempotency / concurrency**: resolution is a compare-and-set `UPDATE … WHERE handle=$1 AND status='pending' AND content_hash=$2 RETURNING …`. Zero rows updated ⇒ `409` (already resolved / stale hash). This is the exactly-once decision guarantee, distinct from the outbox's content-addressed *dispatch* key.

### Suspended Routine State (ALTER — `routine_states`)

Existing per-session routine position, extended:

| Change | Notes |
|---|---|
| `status` value `'suspended'` | **No migration**: `status` is unconstrained `TEXT` (migration 071, no CHECK), so `'suspended'` is insertable as-is. `loadActive` continues to filter `status='active'` → suspended is invisible to the user-turn resume path. `loadSuspended({sessionId})` reads it back (the `SuspendedRoutineReader` maps `handle → session` via `pending_decisions`, then loads the suspended row). |
| abandon clock | when `status==='suspended'`, `save` sets `expires_at = NULL` so the 30-min abandon filter (`expires_at > now()`) cannot drop a routine waiting on a human. |
| concurrency (no optimistic `version`) | The suspended row is never a concurrent-write target: `loadActive` excludes it, routine activation skips when a suspended row exists (FR-004), and resume serializes via the `pending_decisions` CAS inside the atomic resolve+resume+persist transaction. Optimistic versioning is deferred as future hardening. |

### Message Source (ALTER — `messages`)

| Change | Notes |
|---|---|
| `+ source TEXT` (unconstrained) | values `customer \| ai_agent \| human_agent \| human_agent_on_behalf_of_ai_agent \| system`; the last is **reserved/unused** in Tranche A. Nullable; read derives from `role` for pre-existing rows (`user→customer`, `assistant→ai_agent`, `system`). |
| human-message metadata | (reserved for Tranche B) operator id + display name travel alongside `source` for visible attribution. |

`source` is descriptive metadata; the engine never branches on it. Additive/optional on the public API, SDK, MCP.

### Audit & Trace (additive, no new tables required)

- **`RoutineTraceStepEntry.event`** += `suspended | decision_notified | decision_applied` (debug trace; names/keys only — no payload values).
- **`hitl.decision` audit event** (append-only, via the existing audit path): who decided / which step / gate reason / option id / outcome / decided_by / decided_at / content_hash. No raw prompts, completions, retrieved content, or captured slot values.
- **`chat.suspended`** turn outcome signal (distinct from `chat.answer`), so a suspended turn is never counted as an answered/billed turn.

## State transitions

### Pending Decision lifecycle
```
(suspend turn commits) ─▶ pending
pending ──approve (CAS, hash-match, authorized)──▶ approved ─▶ resume routine at gate, enqueue gated action (outbox)
pending ──reject  (CAS, hash-match, authorized)──▶ rejected ─▶ resume routine via authored rejection edge
pending ──conversation ended / superseded──────────▶ cancelled
(redelivered/stale/double submit) ─▶ no-op 409 (status no longer 'pending' or hash mismatch)
```

### Routine state during a gated turn
```
active ──reach `await` step──▶ suspended         (atomic with the suspend assistant turn + pending_decisions row)
suspended ──approved/rejected decision──▶ active  (within the resolve tx) ──▶ runner.resume from gate ──▶ active | completed
suspended ──inbound visitor message──▶ suspended  (loadActive returns null; turn answered normally; no new routine activates)
```

### Atomic commit (the fence)
The suspend turn commits **in one `withTransaction`** (extending `postgresAssistantTurnPersistence.completeAssistantTurn` via the `deferredRoutineStore` command-capture fence): assistant message (the "awaiting review" reply, `source: ai_agent`) + routine state set `suspended` + `pending_decisions` row inserted + the `approval.request` outbox action enqueued + audit. A crash before commit leaves the routine un-advanced (it re-renders the gate), never half-suspended; a routine is never `suspended` without a decision row, and never has a `pending` decision row without being `suspended`.

The resume turn commits the **decision CAS-flip + the resumed assistant turn + routine-state advance** (`suspended→active|completed`) + the gated action **enqueued to the outbox** + trace, **all in one transaction** (the `resolve` CAS runs against that transaction's client — not a prior standalone commit). A crash before commit rolls the flip back, so a retry re-resolves cleanly; the gated effect is dispatched idempotently by a worker, so a rolled-back-then-retried resume never double-fires it. A synchronous side-effecting skill run *during* resume would not be crash-safe — gate an outbox `action`.
