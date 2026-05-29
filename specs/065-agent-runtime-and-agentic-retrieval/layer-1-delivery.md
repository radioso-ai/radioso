# Layer 1 Delivery Plan — Operator-Toggled Agentic Retrieval

**Status:** Draft for review
**Created:** 2026-05-28
**Depends on:** spec 065 (substrate complete in c.1–c.5)
**Out of scope:** Per-query "Deep search" UX (Layer 2), automatic routing (Layer 3)

## Goal

Ship agentic retrieval as a per-workspace operator opt-in. Deterministic remains the default for every workspace, every API call, every chat turn. An operator who flips a setting in the workspace retrieval-settings UI gets the agentic pipeline for that workspace's subsequent retrieval calls — without code changes, env vars, or restarts.

## What this is not

- Not on by default for any workspace, new or existing.
- Not exposed to end users as a per-query toggle in v1 (no chat-UI "Deep search" button).
- Not auto-classified per query — every retrieval call in an agentic workspace uses the agent, regardless of whether the query needs it.
- Not multi-provider — the existing text-routed gateway already works with any configured chat provider; no per-provider tuning ships in this layer.

## What lands in production after Layer 1

1. A persisted `pipeline_mode` field on workspace retrieval settings.
2. A "Retrieval mode" control in the retrieval settings UI, defaulting to **Standard**.
3. The chat path, retrieval API, MCP, and SDK all transparently route through the agentic pipeline when the workspace setting is `agentic`.
4. Telemetry events emitted on every agentic run so operators (and we) can see usage, cost, and termination patterns.
5. Docs explaining what the mode does, when to enable it, and what it costs.

## Work items (ordered for landing)

### W1 — DB migration for `pipeline_mode`

- Add column `pipeline_mode TEXT NOT NULL DEFAULT 'deterministic' CHECK (pipeline_mode IN ('deterministic', 'agentic'))` to the `retrieval_settings` table.
- No backfill needed — the default covers existing rows.
- Add a migration test that asserts existing rows get `deterministic`.

**Surface area:** 1 migration file + 1 test. **Risk:** very low.

### W2 — Repository read/write

- `RetrievalSettingsRepository` reads and writes the column.
- `defaultRetrievalSettings()` already returns `pipelineMode: "deterministic"` (set in c.3) — verify it persists round-trip.
- Add a repository integration test for round-trip.

**Surface area:** ~30 lines in the repo + 1 test. **Risk:** low.

### W3 — Public API + Zod schema + validation

- `RetrievalSettingsRecord` and `RetrievalSettingsInput` already carry `pipelineMode` (c.3). Wire it through:
  - The settings API route's request and response Zod schemas
  - `validateRetrievalSettings` — confirm it rejects values outside the enum (already does via the union type, but assert in a test)
- Regenerate OpenAPI artifacts via `pnpm run generate:openapi`.

**Surface area:** ~10 lines across schema + route + ~3 tests. **Risk:** low; mostly mechanical.

### W4 — SDK contract update

- The TypeScript SDK regenerates from the OpenAPI spec. After W3, run `pnpm --filter typescript-sdk run sync`.
- Add a SDK-level test asserting the field is in the typed `RetrievalSettings` shape.
- The MCP server consumes the same SDK types — no separate work needed.

**Surface area:** generated code + 1 test. **Risk:** low.

### W5 — Frontend settings UI

- Add a "Retrieval mode" radio or segmented control to the existing retrieval settings page.
- Two options: **Standard** (selected by default) · **Agentic (experimental)**
- Helper copy next to the agentic option (one line): *"Slower and more expensive, better at multi-hop questions that need chained searches."*
- The control reads from and writes to the existing settings mutation; no new endpoint.
- A small "Experimental" pill badge to set expectations.

**Surface area:** ~80 lines of React + Playwright coverage for toggling. **Risk:** low — uses existing Radix patterns per CLAUDE.md guidance.

### W6 — Composition switch (replace env-var override)

- Remove the `RADIOSO_AGENTIC_RETRIEVAL=1` env-var path from `backend/src/app/server/dependencyBuilders.ts`.
- Replace with a per-request switch: when the chat path or retrieval API resolves the workspace's settings, route to `AgenticRetrievalPipelineService` if `pipelineMode === "agentic"`, else the deterministic pipeline.
- The agentic service composition (runner, runtime, tool catalog) is already built. The change is in how it's *selected* per workspace.
- The agentic pipeline service is constructed lazily on first agentic workspace access, then cached — avoids paying the construction cost for the (majority) deterministic-only workspaces.

**Surface area:** ~50 lines refactor in dependencyBuilders + 1 integration test that toggles the setting and asserts pipeline selection. **Risk:** medium — touches a production code path. Mitigation: behavior change is gated by an explicit per-workspace setting that defaults off.

### W7 — Telemetry

- Emit a `retrieval.agentic.completed` telemetry event from `AgenticRetrievalRunner` (or one layer up in the pipeline service) with: workspaceId, terminatedReason, stepsTaken, toolResultTokensUsed, wallTimeMs, selectedChunkCount, finalRationalePresent (boolean).
- No new sink; uses the existing `TelemetryService` and configured sinks (per CLAUDE.md "modular extension points").
- One unit test verifying the event is emitted on a stubbed run.

**Surface area:** ~20 lines of code + 1 test. **Risk:** very low.

### W8 — Documentation

- Update `docs/` retrieval settings section: one short subsection on the new "Retrieval mode" toggle. Cover: what it does, when to enable, expected cost / latency multiplier (~2× and ~1.7× based on our measurements), how to read the trace's `summary.agentic` block.
- Update `docs-portal/` operator guide with the same.
- Per CLAUDE.md, read `docs/document-writer-prompt.md` first.

**Surface area:** ~one page of docs across two places. **Risk:** low.

### W9 — Spec status update

- Mark spec 065 sub-slices c.6 and c.7 as delivered.
- Document the deferred Layer 2 and Layer 3 work in the spec's "Resolved Design Decisions" section so future contributors see the deliberate scope cut.

**Surface area:** spec.md edits only. **Risk:** none.

## Out of scope, explicitly

- **Per-query "Deep search" / "Thinking" toggle** — needs UX design, end-user copy, classifier accuracy data. Layer 2.
- **Automatic routing classifier** — needs real usage data from Layer 1 to know how to classify. Layer 3.
- **Billing differentiation** — agentic usage shows up in telemetry but isn't separately billed in v1.
- **Per-tool catalog configuration** — operators can't tune the agent's tool set per workspace. The catalog is the same for every agentic workspace.
- **Per-workspace prompt customization** — the agent's system prompt is the one at `backend/prompts/agentic-retrieval/system.md`; no per-workspace override.
- **A11y review of the toggle** — covered by the general frontend a11y pass, not a new effort here.

## Decisions still owed (operator-visible)

These shape Layer 1 but aren't blockers — picking them is a quick conversation:

1. **Setting name.** Current type uses `pipelineMode: "deterministic" | "agentic"`. The UI doesn't have to expose those exact strings. Options:
   - "Standard / Agentic (experimental)" — direct, technical
   - "Standard / Deep search (experimental)" — softer, end-user-friendly
   - Recommendation: **Standard / Agentic** in operator UI; if Layer 2 ships, end-user UI uses "Deep search."

2. **Experimental tag duration.** When does the (experimental) tag come off? Suggested gate: at least 3 paying workspaces enable it without rolling back, and the agentic trace shows no systemic failures in telemetry over a 4-week window.

3. **Default budgets.** The runtime defaults `maxSteps=6`, `maxToolResultTokens=12000`, `maxWallTimeMs=30000`. Our data shows Q3-style queries can hit the step cap. Two options:
   - Keep defaults — operators can tune later
   - Bump `maxSteps` to 8 — covers the queries that currently exhaust budget
   - Recommendation: **keep defaults for v1**, add settings tuning as a follow-on if telemetry shows widespread budget exhaustion.

4. **Telemetry event sampling.** Emit on every run (small workspaces will tolerate) or sample? Recommendation: **emit on every run** — the runs are minutes apart, not milliseconds, so volume is fine.

## Acceptance criteria

Layer 1 is shipped when:

- An operator can toggle "Retrieval mode" in the workspace settings UI and the change persists across sessions, browser refreshes, and pod restarts.
- A workspace with `pipelineMode = "agentic"` routes its chat retrieval through `AgenticRetrievalPipelineService`. Verified by an integration test that hits `/v1/retrieval/answer` for two workspaces (one of each mode) and inspects the trace shape.
- The `RADIOSO_AGENTIC_RETRIEVAL` env-var override is removed from production code. The integration test for the env-var path is replaced by a settings-based test.
- An operator who switches a workspace to `agentic`, runs a query, and inspects the activity trace sees `kind: "agent_tool_call"` stages and a `summary.agentic` block.
- The retrieval settings docs explain the toggle, the cost/latency expectations, and how to read the trace.
- A telemetry event is emitted for every agentic run with the fields listed in W7.
- All existing tests pass. New code has TDD coverage per CLAUDE.md.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Operator enables agentic and gets surprise bill | medium | medium | "Experimental" badge + cost copy + telemetry to detect early |
| Composition switch breaks deterministic path | low | high | Default off, integration test for both modes, gradual rollout possible |
| Agentic pipeline fails on a workspace's specific corpus | medium | low | Operator can toggle back; telemetry surfaces failures |
| DB migration locks a large `retrieval_settings` table | very low | low | Column add with default value is metadata-only in Postgres |
| SDK regeneration breaks downstream consumers | low | medium | The new field is optional in the SDK input; existing callers unaffected |

## Suggested addition: workspace-level agentic eval

Out of strict scope, but worth considering for Layer 1.5:

A "Compare modes" button in the retrieval settings page that runs the operator-chosen 5 representative queries through both pipelines and shows a side-by-side report — same shape as `scripts/agenticRetrievalCompare.ts`'s output, but in the UI. Reuses the eval harness (spec 064).

This converts "should I enable agentic?" from gut feel into a 30-second empirical test against the workspace's own data. If we ship Layer 1 without this, operators are guessing — and an operator who guesses wrong wastes spend and may roll back, generating support load.

**Effort:** ~2 days, mostly UI. **Value:** materially reduces the decision cost for operators evaluating the feature.

Recommend including this in Layer 1 scope if eval (064c) has shipped, else deferring to Layer 1.5.

## Effort estimate

Total: **~10–12 engineer-days** for a single contributor, possibly less in parallel.

| Item | Days |
|---|---:|
| W1 migration | 0.5 |
| W2 repository | 0.5 |
| W3 API + Zod + OpenAPI | 1 |
| W4 SDK | 0.5 |
| W5 frontend toggle + Playwright | 2 |
| W6 composition switch + integration tests | 2 |
| W7 telemetry | 1 |
| W8 docs | 1 |
| W9 spec status | 0.5 |
| Reviews, fixups, surprises | 2 |

This is small relative to the substrate work already done (c.1–c.5 was the hard part). Layer 1 is mostly plumbing.
