# Quickstart / Verification: Unified Skill Model

How to demonstrate each slice end-to-end. Backend runs via `./run-dev.sh`; targeted backend tests via `pnpm exec vitest run <path>`; frontend journey via Playwright; full gate via `pnpm run ci:local -- origin/main`.

## F0 — capability registry + unified API (no behavior change)

1. `GET /agents/{id}/skill-capabilities` returns the registry projection: each capability (`mcp_tool`, `email`, `slack_post`, `webhook_call`) with its connectable targets, input schema, outcome vocabulary, and supported invocation modes. Capabilities with no connection are flagged unavailable.
2. `GET /agents/{id}/skills` returns all existing MCP/email/Slack/webhook skills uniformly (same envelope), each with `invocation_mode` (`routine_named` after backfill).
3. Create an MCP skill via `POST /agents/{id}/skills` and confirm it lands on `agent_skills` with the correct stored kind and is invocable from a routine by `@name` exactly as before.
4. Regression: existing per-kind suites green; existing routine→skill dispatch unchanged.

## US1 — one Skills list + Add-skill form

1. Open an agent's Skills tab: one list of named skills + one "Add new skill" button (no per-channel cards).
2. "Add new skill" → pick capability → form renders that capability's targets + inputs (bound/exposed) in the same layout for every capability.
3. A capability with no connection shows as unavailable with a connect pointer; cannot be selected.
4. The form never edits connection credentials.
5. Playwright covers: open tab → add one skill of each available capability → see it in the list → reference it in a routine.

## US2 — retrieval as a named skill

1. After migration: `GET /agents/{id}/skills` shows exactly one `retrieve` skill with `invocation_mode=default_answer`; a normal chat turn produces the same grounded answer as before (regression eval: 0 diffs).
2. Add a `retrieve` skill `@retrieve_events` scoped to one dataset with an instruction; reference it from a routine step.
3. Run the routine: retrieval is restricted to that scope, uses the instruction, and the step receives a structured found/empty outcome it can branch on.
4. Editing the default-answer skill's tuning behaves like today's retrieval settings (same fields, same workspace-default inheritance; `similarityThreshold` not exposed).

## US3 — invocation mode

1. Create three skills with the three modes; verify: `default_answer` runs as the implicit answer on non-routine turns; `routine_named` runs only when `@name`d (never auto-selected); `agent_selectable` is eligible for autonomous selection.
2. Attempt a second `default_answer` skill → rejected (unique index).
3. Attempt an unsupported (capability, mode) pair → rejected by the registry.

## US4 — notify + webhook_call fold

1. After migration: an agent that had contact requests enabled has a `notify` skill with the same recipients/webhook; the public-chat "contact a human" affordance still appears and delivers to the same destinations; disabling the skill hides it.
2. An agent that had webhook exports enabled has a `webhook_call` skill bound to its destination; a published routine completing still exports to that destination exactly once.
3. Skills tab now shows zero bespoke capability cards — only the unified list + agent appearance settings (citations, theme, link UTM). Suggested-questions appears as a setting on the default-answer retrieve skill.

## Cross-cutting checks

- OpenAPI regenerated (not hand-edited); SDK/MCP skills surface in sync.
- Logs/metrics/traces for skill CRUD + capability resolution carry identities/counts only — no credentials, message text, retrieved chunks, or tokens.
- Docs updated: Skills authoring guide, settings docs, SDK/MCP refs, routine docs referencing skills.
- `pnpm run ci:local -- origin/main` green before each PR.
