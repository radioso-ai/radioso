# Data Model: Clarification Capability (085)

## Contract types (packages/conversation-contract/index.d.ts)

### ClarificationCandidate

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | unique within the candidate set |
| `label` | `string` | short human-readable; LLM question is phrased from this |
| `description` | `string?` | optional extra phrasing context |
| `confidence` | `number` | 0–1, **ordinal within its set only** |
| `payload` | `unknown` | opaque to the Clarifier; owned by the detector |

### ClarificationPolicy (per surface)

| Field | Type | Notes |
|---|---|---|
| `floor` | `number` | min confidence to remain a candidate |
| `margin` | `number` | top-vs-runner-up gap that counts as a clear winner |
| `maxOptions` | `number` | cap on presented options (default 4) |

### ClarificationDecision (pure output of decide)

```
{ kind: "auto_pick", candidate, reason: "clear_margin" | "priority" | "suppressed" | "loop_guard" }
| { kind: "ask", candidates: ClarificationCandidate[] }   // ≤ maxOptions, deterministic order
| { kind: "none" }                                        // nothing cleared the floor
```

Deterministic ordering everywhere: confidence desc, then surface-supplied
priority desc (routine activation only), then id.

### PendingClarification

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string` | conversation/session scope; at most one row per session |
| `source` | `string` | `"routine_activation"` \| `"retrieval_sense"` (open string for future detectors) |
| `candidates` | `ClarificationCandidate[]` | as presented (with payloads) |
| `askedEventId` | `string?` | the assistant question event |
| `status` | `"pending" \| "resolved" \| "declined" \| "expired"` | non-pending rows persist until TTL for the loop guard |
| `expiresAt` | timestamp | mirrors routine-state TTL (30 min default) |

### ConversationClarificationStore (port)

`loadPending({sessionId}) → PendingClarification | null` (also surfaces the most
recent non-pending row within TTL for loop-guard checks),
`save(pending)`, `clear({sessionId, outcome})`.

### Clarifier LLM ports (implemented in conversation-defaults, prompts injected)

- `phraseQuestion({candidates, turn}) → string` — conversation-language question.
- `mapReply({candidates, turn}) → { kind: "chosen", id } | { kind: "declined" } | { kind: "unrelated" }`.

### Routine activation outcome (contract change)

`ConversationRoutineActivator.activate` returns
`{ kind: "activate", routineId, variables? } | { kind: "clarify", candidates } | null`
(was `{routineId, variables?} | null`). Candidate payload for this surface:
`{ routineId, variables? }`.

## Database

### Table `clarification_states` (new migration, next sequential number)

| Column | Type | Notes |
|---|---|---|
| `session_id` | UUID PK | one row per session |
| `source` | TEXT | detector source id |
| `candidates` | JSONB | candidate array incl. payloads |
| `asked_event_id` | TEXT NULL | |
| `status` | TEXT | `pending/resolved/declined/expired` |
| `expires_at` | TIMESTAMPTZ | |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

Partial index on `(session_id) WHERE status = 'pending'` (mirrors
`071_routine_states.sql`). Candidate payloads contain document ids / routine ids
only — no document content.

## Retrieval module additions

- `RetrievalPipelineRequest.documentScope?: string[]` — post-retrieval allow-list
  filter applied at candidate preparation (before rerank).
- Sense detector output (retrieval-internal type): qualifying groups
  `{ documentIds, share, separation }` → mapped to ClarificationCandidates with
  LLM labels; payload = `{ documentIds }`.

## State transitions

```
(no row) --ask committed with turn--> pending
pending --reply maps to candidate--> resolved (+ surface continuation, same turn commit)
pending --declined / unrelated-----> declined (normal turn proceeds)
pending --TTL lapse----------------> expired (lazily, on next load)
resolved/declined/expired --TTL---> (row eligible for cleanup; loop guard reads declined until then)
```

Invariants: at most one `pending` per session; a turn that resolves a pending
clarification never creates a new one; ask/resolve transitions commit only via
the assistant-turn transaction (deferred capture), never mid-turn.

## Trace stage (spine, kind `clarification`)

Outputs (metadata-safe): `surface`, `decision`, `reason?`, `margin?`,
`candidates: [{id, label, confidence}]` (no payloads, no document content),
`mappingOutcome?`. Envelope version unchanged (additive).
