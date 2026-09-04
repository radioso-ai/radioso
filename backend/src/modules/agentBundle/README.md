# Agent Bundle Module

Agent Bundle owns the portable form of a whole agent: exporting one workspace's
agent as data, and importing that data as a new agent somewhere else. Start here
when a feature changes what travels with an agent, how a non-portable reference is
represented, or what an operator is told after an import.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).
Design record: [`specs/100-portable-agent-authoring/plan-agent-bundle.md`](../../../../specs/100-portable-agent-authoring/plan-agent-bundle.md).

## Boundaries

This module knows which pieces make up an agent and how each one crosses a
workspace boundary. It depends on the `public.ts` of `agents`, `routines`,
`context-variables`, `agentSkills` and `skills` — broad knowledge depending on
narrow — and it declares its own read/write ports so nothing here knows which
concrete service answers a given read. `app/composition/agentBundleComposition.ts`
does that adapting.

It does not own agent settings, routine authoring, skill configuration or context
variable definitions. Every write goes through the owning module's service so its
validation, uniqueness rules and audit behavior apply unchanged.

## The bundle composes `AgentConfig`; it does not extend it

`AgentConfig` (in `modules/agents`) stays agent-shaped and
keeps its own version, because its other consumer is eval replay:
`materializeAgentFromConfig` turns an `InternalAgentConfig` back into a
`ConversationAgent`. Routines, context-variable enablements and agent skills are
not part of a `ConversationAgent`, so putting them in `AgentConfig` would add
fields replay must deliberately ignore and would grow every
`eval_snapshots.original_agent_config` row with data replay cannot use.

The one thing the two directions do share is `splitRetrievalAnswerEnvelope`:
`AgentConfig` wraps the default retrieve skill in an envelope carrying agent-level
fields, while the stored agent keeps them flat. Import reuses the agents module's
own splitter rather than re-deriving it.

## What travels, and what does not

Most references are already natural keys, which is why import needs almost no
re-mapping: a routine names its skill in `toolRef` and its context variables by
name, and a directive's `binding.skillName`, `dependsOn` and `excludes` are all
names. Only three references are workspace-scoped ids:

| Reference | Treatment |
|---|---|
| `agent_context_variables.variable_id` | re-keyed to the variable's name |
| `agent_context_variables.resolver_skill_id` | re-keyed to the skill's name |
| `agent_skills.target_type` / `target_id` | a credential-bearing connection: `ref` placeholder, imported unbound |

Skill `config` values travel only for fields a capability marks
`portable: true` (see `skills/capabilityRegistry.ts`). The default is that a value
stays home, because `agent_skills.config` is where a webhook URL or a recipient
list lives.

## Versioning rule

`AGENT_CONFIG_SCHEMA_VERSION` bumps whenever the field set changes, including
additively. A defaultable new field is harmless to an older reader, but leaving the
version alone lets two deployments disagree about what one version contains — and
the import gate would wave through a config whose new fields it silently ignores.
Readers therefore declare the versions they accept (`SUPPORTED_AGENT_CONFIG_VERSIONS`
in `importService.ts`) and what an absent field means. An older version stays
accepted only while every field it lacks defaults to the behaviour that version had.

## Import rules worth keeping

- **Never widen.** A selected source scope whose ids cannot be matched imports as
  selected-and-empty, never as `all`. A surface whose token was redacted imports
  off rather than minting a new one.
- **Report, never drop.** Everything that could not be applied comes back in
  `unresolved` as `{ kind, element, detail }`. An agent that imports quietly minus
  a skill binding is an agent that looks configured and answers wrong.
- **Per-element failures are not fatal.** A skill whose capability requires a bound
  target legitimately fails to create; that is reported and the import continues.
  Only the agent create is fatal, and a fatal failure deletes the agent it created.
- **Order is load-bearing.** Skills are written first because everything else names
  one: a directive's `binding.skillName`, a routine step's `toolRef`, and a
  context-variable enablement's resolver are all validated against the agent's
  skills. A directive whose binding still cannot be satisfied is written disabled
  rather than dropped — the directive service skips binding validation for a
  disabled directive, so the retry defers to its rules instead of restating them.
- **Versions are checked, not guessed.** An unsupported `bundleVersion` or
  `agent.schemaVersion` is rejected before anything is written.

## Known follow-up

`agentConfig.ts`'s skill-settings projection copies the whole `agents.skill_settings`
JSONB column, filtering only the `retrieval.answer` envelope. That predates this
feature and is safe today because `AgentSkillSettingsRegistry` registers only
`retrieval.answer`, whose fields carry no credentials — but it sits entirely outside
the `agentSkills[].config` allowlist this module added, so a second registration
under that older mechanism would reach the bundle with none of these controls
applying. Worth an issue.

## Not yet portable

MCP connections and external skills are exported (the agents module already
projects them with credentials placeheld) but are not re-created on import: a
connection needs its credential re-entered or its OAuth flow re-run before it can
serve. Each one is reported in `unresolved` so the operator knows what to rebuild.

Import always creates a new agent. Importing into an existing agent is a merge and
needs a collision policy that has not been decided.

## Operator surface

Export is an action on the agent's Profile page
(`frontend/components/dashboard/settings/agent-bundle-export-card.tsx`); import is a
third option in the Create agent dialog and in the zero-agent empty state
(`frontend/components/dashboard/agent-bundle-import-dialog.tsx`). The dialog reads
the file client-side and shows its contents before creating anything, then renders
the `unresolved` report grouped by element — that report is the reason import has a
dialog rather than a plain upload button.

## Tests

- `backend/tests/unit/agent-bundle-export.test.ts` — what leaves the workspace
- `backend/tests/unit/agent-bundle-import.test.ts` — resolution, degradation, compensation
- `backend/tests/unit/agent-bundle-routes.test.ts` — the HTTP round trip and its audit trail
- `backend/tests/unit/skill-capability-portability.test.ts` — the opt-in config allowlist
- `frontend/tests/unit/agent-bundle.test.ts` — file reading, filename safety, grouping
- `frontend/tests/e2e/agent-bundle.spec.ts` — the operator journey both ways
