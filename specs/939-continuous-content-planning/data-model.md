# Data Model: Audience Pulse v1

## Persistent Snapshot

### `audience_pulse_snapshots`

One row per workspace, keyed by `workspace_id`.

| Column | Type | Meaning |
|---|---|---|
| `workspace_id` | UUID primary key/FK | Scope boundary for one current report. |
| `revision` | UUID | Generated on every successful replacement; used for conditional invalidation. |
| `period_start` / `period_end` | timestamptz | Inclusive/exclusive UTC analysis period. |
| `generated_at` | timestamptz | Time the report was validated and saved. |
| `report` | JSONB | Validated report without raw conversation excerpts or provider text. |
| `prompt_evidence_refs` | JSONB | Opaque source references for every item supplied to the model, including omitted items. |
| `created_at` / `updated_at` | timestamptz | Lifecycle timestamps. |

`replace()` atomically upserts a fully validated report and new revision. `find()` returns
the revision and full prompt evidence set. `invalidate(workspaceId, revision)` deletes
only when both values match; if it returns false, the reader re-fetches/revalidates the
newer snapshot rather than deleting it.

## Ports

### `AudiencePulseHistorySource`

Input: `{ workspaceId, analysisStart, analysisEnd, samplePolicy }`.

Output:

- exact UTC-week eligible-question and distinct-conversation aggregates plus total
  population before sampling;
- a bounded sample: opaque evidence ID, source reference, UTC week/channel, transient
  question excerpt, grounding state, typed skill outcome, conversation ID, and
  server-owned `contentGapEligible`.

The Chat adapter applies the eligible-user and pairing rules. Excerpts are model input
only; they never enter `audience_pulse_snapshots`.

### `AudiencePulseSnapshotStore`

`find(workspaceId)`, `replace(snapshot)`, and
`invalidate({ workspaceId, expectedRevision })`. It contains no model, authorization, or
report policy.

### `AudiencePulseRunGate`

`tryAcquire(workspaceId)` returns a releaseable lease or `null`. The production adapter
uses a non-blocking Postgres session advisory lock held on one pinned Kysely connection.
Its `release()` is idempotent; connection/process loss releases the lock.

### `AudiencePulseInferenceFactory`

Accepts `{ workspaceContext, modelCallContext }`, where `modelCallContext` is the
generic typed model-call/usage context owned by the caller. It resolves a cached chat
capability client and returns a `ModelInferencePipeline`; it has no Audience Pulse
product rules.

## Report Invariants

| Field | Owner | Invariant |
|---|---|---|
| Period, coverage, weekly volume | Server | Exact full-population values. |
| Summary/title/description/caveat/recommendation prose | Model then Zod | Bounded visible prose only. |
| Theme evidence IDs | Model then server | Two or more IDs; each ID belongs to at most one theme. |
| Counts/pulse/grounding/gap projection | Server | Derived from verified evidence membership. |
| Recommendation evidence | Model then server | Non-empty parent-theme subset with two qualifying IDs from two conversations. |
| Source references | Server | Every prompt evidence ref persists for future authorization; rendered excerpts rehydrate on GET. |

`contentGapEligible` is true exactly for `retrieval.answer:no_context` with
`no_support`, or `retrieval.answer:grounded_degraded` with `degraded`. All human,
unpaired, unknown, unavailable, out-of-scope, and other-skill states are false.

Recommendation prose remains model-authored, but its visible evidence is server-bound.
When a recommendation names a valid parent theme yet cites an insufficient subset, the
server deterministically binds it to two qualifying parent evidence items from distinct
conversations. If the parent has no recurring qualifying evidence, the advisory
recommendation is omitted. Unknown evidence and evidence outside the parent theme still
invalidate the model result.

## Browser-only Draft Intent

`sessionStorage` contains `{ accountId, workspaceId, title, content }`. `content` is a
Markdown bullet list made from the recommendation's visible questions. The Documents
composer reads a matching key once and immediately clears it; mismatch, cancellation,
and workspace change also clear it. No draft record is persisted.
