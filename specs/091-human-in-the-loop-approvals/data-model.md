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
| `status` gains `'suspended'` | `loadActive` continues to filter `status='active'` → suspended is invisible to the user-turn resume path. `loadSuspended(handle)` reads it back by handle. |
| `+ version INT NOT NULL DEFAULT 0` | optimistic concurrency; `save` becomes version-guarded (`… WHERE version=$expected`); a losing resume → `409 conversation_moved`. |
| abandon clock | while `suspended`, `expires_at` is set NULL/far-future so the 30-min abandon sweep cannot drop a routine waiting on a human. |

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
pending ──approve (CAS, hash-match, authorized)──▶ approved ─▶ resume routine at gate, run gated step
pending ──reject  (CAS, hash-match, authorized)──▶ rejected ─▶ resume routine via authored rejection edge
pending ──conversation ended / superseded──────────▶ cancelled
(redelivered/stale/double submit) ─▶ no-op 409 (status no longer 'pending' or hash mismatch)
```

### Routine state during a gated turn
```
active ──reach `await` step──▶ suspended         (atomic with the suspend assistant turn + pending_decisions row)
suspended ──approved/rejected decision──▶ active  (version-guarded) ──▶ runner.resume from gate ──▶ active | completed
suspended ──inbound visitor message──▶ suspended  (loadActive returns null; turn answered normally; no new routine activates)
```

### Atomic commit (the fence)
The suspend turn commits **in one `withTransaction`** (extending `postgresAssistantTurnPersistence.completeAssistantTurn` via the `deferredRoutineStore` command-capture fence): assistant message (the "awaiting review" reply, `source: ai_agent`) + routine state set `suspended` + `pending_decisions` row inserted + the `approval.request` outbox action enqueued + audit. A crash before commit leaves the routine un-advanced (it re-renders the gate), never half-suspended; a routine is never `suspended` without a decision row, and never has a `pending` decision row without being `suspended`.

The resume turn commits the resumed assistant turn + routine-state advance (`suspended→active|completed`, version-guarded) + any emitted action + trace, atomically, after the decision row is CAS-resolved.
