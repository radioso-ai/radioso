# Amendment: Routine Versioning & Lifecycle (edit published, supersede, archive)

**Parent**: `specs/082-routines-as-data/spec.md`
**Created**: 2026-06-12
**Status**: Design (pre-plan)
**Realizes**: the parent's **US4 — Edit And Re-Version A Routine Without Breaking Live Conversations** (spec.md §US4) and the plan's immutable-per-version decision (plan.md: "a published `routine_definition` is immutable per version (publish snapshots a new row)"). The authoring-surface amendment shipped draft authoring; this amendment ships the lifecycle around it.

---

## 1. Motivation

Today a published routine is a dead end: the editor greys out every field for `status = 'published'`, deletion is draft-only (`deleteDraft` filters `status = 'draft'`), and there is no unpublish, archive, or revise path. Operators cannot iterate on, retire, or remove a routine after their first publish.

Two latent correctness bugs make this urgent beyond UX:

1. **Double activation.** `publish()` already snapshots a new row (`routineDefinitionRepository.ts:273-318`) with `version = MAX(version)+1` keyed by `(agent_id, name)`, but nothing supersedes the prior published version. `listPublishedByAgent` returns *all* published rows and the composition registers all of them as activation candidates (`backend/src/app/composition/routineDefinitionSource.ts`). Republishing under the same name leaves two live versions competing for activation.
2. **Stray drafts.** Publishing inserts the published snapshot but never consumes the draft row, so the list accumulates a draft + published pair per publish.

In-flight pinning currently works only by accident: `routine_states.routine_id` pins the definition UUID (migration `071_routine_states.sql`; not a FK), and resume succeeds because old versions stay `published`. Once superseding exists, resume must work for non-published pinned versions explicitly.

## 2. Lifecycle model

### 2.1 Lineage identity

- `routine_definition` gains an explicit **`lineage_id`** (UUID, NOT NULL). All versions of one authored routine share it; backfill groups existing rows by `(agent_id, name)`. Version numbering (`MAX(version)+1`) and active-version resolution key on `lineage_id`, not `name` — rename stops being identity, consistent with the parent's Stable-Identity Rule (which already removed meaning from labels at the step level).
- **At most one draft per lineage** (partial unique index). The draft is "the pending revision" of the lineage.

### 2.2 Statuses and transitions

`status ∈ { draft, published, superseded, archived }` (extends the current `draft|published` CHECK).

```
draft ──publish──────────────► published ──(newer version published)──► superseded
  ▲                              │      ▲
  │                         archive   restore
edit published                   ▼      │
(copies into new draft)       archived ─┘
```

- **Revise (edit published)**: creates a new draft row in the same lineage, pre-filled from the active published version — children copied with **stable step/slot ids preserved verbatim**, completion-export config carried over. If the lineage already has a draft, revise resolves to that existing draft (no second draft).
- **Publish (revision)**: in one transaction — insert the published snapshot at `version = MAX(version in lineage)+1`, mark the previously published version of the lineage `superseded`, and **consume the draft row**. Existing publish-time validation (graph validity, action capabilities, webhook destination references) is unchanged.
- **Archive**: operator action on the lineage's active published version → `archived`. The lineage stops activating for new conversations and is visually retired in the dashboard.
- **Restore**: `archived → published`, allowed only when the lineage has no other currently-published version (publishing a new revision of an archived lineage is also a valid way to re-activate it; the archived row then stays archived as history).
- **Draft delete**: unchanged (drafts only). `superseded` and `archived` rows are never hard-deleted — `routine_states.routine_id`, traces, and directive history reference definition ids by value, and FKs cascade; hard delete is an explicit anti-goal of this amendment.

### 2.3 Runtime rules

- **Activation**: only `published` versions are activation candidates. After supersede or archive, new conversations never enter the old version.
- **In-flight pinning (finish-on-pinned-version)**: a conversation whose `routine_state` pins version N continues and completes on N even after N is superseded or archived. The engine's routine source MUST resolve a session's pinned definition regardless of its status (today it only loads `published` rows — this is the explicit fix for the accident described in §1). No mid-conversation migration in this amendment; the parent's migrate-vs-finish policy hook stays open.
- **Scoped directives follow the lineage**: directive scope tags reference the definition id (`routine:<id>`, `step:<id>:<stepId>`). On publish of version N+1, tags scoped to the lineage's previously published version MUST be re-pointed to the new definition id where the referenced step still exists (deterministic — step ids are stable). Tags whose step no longer exists in N+1 MUST NOT be silently re-pointed or dropped: they stay on the old id and are **surfaced as orphans** in the publish result (parent Stable-Identity Rule: "orphaned scope tags MUST be surfaced on edit").
- **Completion exports**: per-version rows (`routine_completion_export`, PK `definition_id`) — revise copies the config into the new draft, publish validates it as today. Webhook dispatch uses the pinned version's config for in-flight completions.

## 3. Dashboard surface

- **List = one row per lineage.** The routines list shows each lineage once: name, the lineage's current state (published / draft-only / archived), active version number, and a "draft revision" badge when a published lineage has a pending draft. Individual versions never appear as sibling rows.
- **Archived lineages** are out of the default view (collapsed section or filter) with a restore action.
- **Routine details get a version history panel**: each version with number, status, and created/published timestamps; past versions are viewable read-only. The editor itself continues to edit only the draft.
- **Edit on a published routine** invokes revise and opens the draft revision (or the existing one). The greyed-out read-only published view remains for history viewing, now clearly framed as "version N (read-only) — edit creates a revision".
- The list/read contracts MUST expose lineage identity and status so the dashboard renders lineage rows without client-side identity guessing (e.g. `lineageId` on the routine resource; exact list-vs-grouped contract shape is a plan decision).

## 4. Boundary rules

- **Transport** (`agentRoutes.ts`): new lifecycle endpoints (revise, archive, restore) validate and shape only; no lifecycle rules in routes.
- **Orchestration/domain** (`backend/src/modules/routines/`): owns lifecycle transitions, lineage rules, supersede semantics, and the scoped-directive re-pointing decision. Directive scope-tag persistence stays owned by the directives/agent repository — the routines module calls a narrow port, it does not write `agent_directives` itself.
- **Persistence** (`routineDefinitionRepository.ts`, migration): owns lineage column, status transitions' atomicity, and snapshot copying.
- **Engine packages stay routine-identity-free** (parent SC-006): pinned-version resolution is a composition/source concern (`routineDefinitionSource.ts` / session-prep), not an engine branch.
- **Anti-goals**: no hard delete of published/superseded/archived versions; no mid-conversation version migration; no version diffing UI; no draft-of-a-draft stacking; no second routines list surface.

## 5. New requirements (extend the parent; numbering continues the authoring amendment)

- **FR-025**: Routine versions MUST share an explicit lineage identity persisted on `routine_definition`; version numbering and active-version resolution MUST key on lineage, not name. A lineage has at most one draft at a time.
- **FR-026**: Operators MUST be able to revise a published routine: revise creates (or resolves to) the lineage's draft, pre-filled from the active published version with stable step/slot ids and completion-export config preserved.
- **FR-027**: Publishing a revision MUST atomically: snapshot the draft as the new published version, mark the lineage's previously published version `superseded`, and consume the draft row. At most one `published` version per lineage may exist at any time.
- **FR-028**: Only `published` versions activate for new conversations. A conversation mid-routine MUST continue and complete on its pinned version even when that version is `superseded` or `archived`; the runtime routine source MUST resolve pinned non-published versions for in-flight sessions.
- **FR-029**: Operators MUST be able to archive a lineage's active published version (stops activating, retired in UI) and restore it (archived → published) when the lineage has no other published version. `superseded`/`archived` versions MUST NOT be hard-deletable; draft deletion is unchanged.
- **FR-030**: On publish of a new version, directive scope tags referencing the lineage's previously published version MUST be re-pointed to the new version where the referenced step survives; tags referencing steps that no longer exist MUST be surfaced as orphans in the publish result, never silently dropped or re-pointed.
- **FR-031**: The dashboard routines list MUST show one row per lineage (state + active version + pending-draft badge); routine details MUST provide a version history with read-only access to past versions; archived lineages MUST be restorable from the UI.
- **FR-032**: Lifecycle transitions (publish/supersede, archive, restore, revise) MUST emit audit events with workspace/agent/routine/version correlation and no document content. HTTP contract changes MUST be registered in the code-first OpenAPI registry with regenerated artifacts, and authoring docs MUST cover the lifecycle (revise → publish → supersede, archive/restore, in-flight behavior).

## 6. New success criteria

- **SC-017**: Editing a published routine and republishing yields exactly one active version: a new conversation activates N+1 while a conversation that was mid-routine on N completes on N (parent US4 independent test, now executable end-to-end).
- **SC-018**: After any number of revise/publish cycles, the routines list shows exactly one row for the lineage and zero stray draft rows; the version history shows every version with correct statuses.
- **SC-019**: An archived lineage never activates for new conversations; restore re-activates it; an in-flight conversation pinned to the archived version completes unaffected.
- **SC-020**: A directive scoped to a step that survives a revision applies to the new version with no operator action; a directive scoped to a removed step is reported as orphaned at publish.
- **SC-021**: Republishing under a renamed routine stays in the same lineage (rename is not identity).

## 7. Delivery split

1. **Lineage + status model (backend, TDD).** Migration: `lineage_id` + backfill + partial unique draft index + status CHECK extension. Repository: lineage-keyed versioning, supersede-on-publish, draft consumption, revise-copy with id preservation, archive/restore. Service rules + audit events.
2. **Pinned-version runtime resolution.** Routine source resolves a session's pinned definition regardless of status; integration test: supersede mid-conversation, conversation completes on N while a new session activates N+1 (SC-017/SC-019).
3. **Scoped-directive re-pointing.** Re-point on publish via a narrow directives port; orphan surfacing in the publish response (SC-020).
4. **HTTP contract + OpenAPI + SDK review.** Revise/archive/restore endpoints, lineage fields on read/list contracts, regenerated `openapi.yaml`/`openapi.json`, contract tests; message-queue impact review (expected: none — completion-export dispatch already keys on definition id).
5. **Dashboard.** Lineage-grouped list with badges and archived section, version history panel, revise flow from the read-only published view. Playwright coverage for: revise→publish supersede journey, archive/restore, lineage-grouped list.
6. **Docs.** Authoring docs gain the lifecycle section (revise, supersede, archive/restore, in-flight pinning); settings/API docs updated alongside the contract.

## 8. Open questions / risks

- **List contract shape** (flat with `lineageId` + client grouping vs. server-grouped lineage resource) — plan decision; the spec constraint is only that the UI never guesses identity.
- **Pinned-version source plumbing**: today the registration list is built per-turn from `listPublishedByAgent`; the cleanest seam for "also load this session's pinned definition" (source vs. session-prep) is a plan decision; the engine must stay identity-free either way.
- **Directive re-pointing transactionality**: re-point in the publish transaction vs. immediately after — decide in plan; orphan reporting must be consistent with whichever is chosen.
- **Existing data**: backfill creates one lineage per `(agent_id, name)` group; verify no existing agent has two same-name published rows intended as *different* routines (believed impossible via the UI, confirm in migration review).
