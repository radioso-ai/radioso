# Implementation Plan: Agent Bundle Export/Import (spec 100, US2)

**Scope**: US2 only. US1 (markdown intake) is deliberately NOT revived — see
"Format decision" below. US3 gains two SDK methods for the endpoints this slice
adds; US4 (kit loading) stays out.

## What reading the code changed

The spec's plan assumed the hard part was reference re-mapping: "directive scope
tags referencing routines/steps resolve to the imported routines' stable ids",
plus skill and context-variable ids across workspaces. That is mostly not true of
the schema as it stands today.

- A `RoutineDefinition` carries **no workspace-scoped id at all**. `toolRef` is a
  skill *name* (`routines/validator.ts:196` checks it against
  `availableSkillNames`), slot bindings name a context variable by *name*
  (`binding.contextVariable`), and `stableStepId` is routine-local. A published
  routine is portable data as-is.
- An authored directive is name-keyed too: `binding.skillName` is a name,
  `dependsOn`/`excludes` are directive names, `tags` are free text. There are no
  routine or step ids in the directive schema, so the spec's scope-tag remapping
  has no referent.

The genuine non-portable references reduce to three:

| Reference | Treatment |
|---|---|
| `agent_context_variables.variable_id` | re-key to the variable's `name` |
| `agent_context_variables.resolver_skill_id` | re-key to the skill's `skillName` |
| `agent_skills.target_type` / `target_id` | a workspace connection holding credentials — **cannot travel**; emitted as a `ref` placeholder and imported unbound |

## Format decision

The bundle carries `RoutineDefinition` JSON, not markdown. US1 shipped markdown
intake in #847 and #1064 retired it four weeks later along with the Prose editor;
`routines/portableDocument.ts:11` records the surviving direction as
serialize-only. A bundle of definition JSON survives an editor change; a grammar
does not. Markdown stays what it is today — a rendering, for Ray to read.

## Boundary decision: bundle composes AgentConfig, it does not extend it

The obvious move is `AGENT_CONFIG_SCHEMA_VERSION` 3 → 4 with three new fields.
Rejected:

- `AgentConfig`'s other consumer is replay. `InternalAgentConfig` exists to be
  fed to `materializeAgentFromConfig`, which builds a `ConversationAgent` —
  and routines, context-variable enablements and agent skills are **not** part of
  a `ConversationAgent`. They would be fields that materialization must
  deliberately ignore, and dead override slots on the workbench replay surface.
- `eval_snapshots.original_agent_config` is written on every capture. Adding
  routine definitions to `AgentConfig` grows every snapshot with data replay
  cannot use.

So `AgentConfig` stays at v3 and agent-shaped, and a new `agentBundle` module
composes it with the three sibling collections. Two consumers, two ports.
(If routine-fidelity replay is wanted later, the bundle type is the thing to
reuse — that is a separate feature with its own wiring.)

## Module

`backend/src/modules/agentBundle/` — broad-knowledge module depending only on the
`public.ts` of agents, routines, context-variables, agentSkills, skills. It
declares its own narrow read/write ports; composition adapts the concrete
services to them.

```
domain.ts         AgentBundle types, AGENT_BUNDLE_SCHEMA_VERSION, unresolved kinds
ports.ts          narrow reader/writer ports
exportService.ts  ConversationAgent + siblings -> AgentBundle
importService.ts  AgentBundle -> new agent, with an unresolved-reference report
public.ts
```

## Skill config portability

`agent_skills.config` can hold credentials and personal data — the capability
registry already says so where it gates `showValueToCopilot` ("never for anything
that can carry a credential, token, or personal data (for example notify's
delivery.webhook.url or delivery.recipientEmails)").

That flag governs what the *model* reads, which is a different trust boundary
from what an *operator* moves between their own workspaces, so it is not reused.
Instead `SkillCapabilitySettingsField` gains `portable?: boolean`, default false.
A capability author opting a field into the bundle is an explicit act; silence
means the value stays home. Only `retrieve`'s tuning fields are marked portable
in this slice.

## Atomicity

Import creates a **new** agent (import-into-existing was an unresolved open
question in the spec and is a different feature — merge semantics, id collision
policy). Every child table cascades on `agents` delete, so a failure part-way
through compensates by deleting the agent it created. That is compensation, not a
transaction: threading one `trx` through four modules' services would invert the
dependency direction this module exists to respect. A process crash mid-import
can therefore leave a partial agent; the import is not resumable and the caller
is told which references did not resolve.

## Slices

1. `agentBundle` domain + export service + `GET /api/v1/agents/{agentId}/bundle`
2. import service + `POST /api/v1/agents/bundle`, unresolved-reference report
3. SDK methods + docs

## Observability

Export and import both emit audit events (`agent.bundle.exported`,
`agent.bundle.imported`) carrying agent id, bundle version and — for import — the
count of unresolved references. No bundle contents in logs: a bundle holds the
agent's custom instruction and directive text.

## What implementation changed

Three things the plan above got wrong or under-specified, corrected while building:

1. **Export and import are not symmetric about skill settings.** `AgentConfig`
   wraps the default retrieve skill in an envelope
   (`skillSettings["retrieval.answer"].settings.__agentRetrievalDefaults`) carrying
   agent-level fields that are flat on the stored agent. Import reuses the agents
   module's own `splitRetrievalAnswerEnvelope` — now exported — rather than
   re-deriving the split, so the two directions cannot drift.
2. **Per-element failure must not be fatal.** A capability that requires a bound
   target legitimately rejects the null target an unbound skill imports with. The
   first cut aborted the whole import; that would mean an agent with one webhook
   skill could never be imported. Only the agent create and the directive writes
   are fatal now.
3. **`publish` returns a rejection, it does not throw.** `RoutineDefinitionService`
   models a validation rejection as a result. The routine writer port returns an
   outcome so an adapter never has to turn a normal outcome into an exception.

## Deferred, deliberately

MCP connections and external skills are exported but not re-created on import.
The `AgentConfig` projection already models them for portability (a within-bundle
`key`, credentials placeheld), so the data is there — but a connection cannot serve
until its credential is re-entered or its OAuth flow re-run, so it needs the
operator regardless. Import reports each connection and each external skill in
`unresolved` instead of silently dropping it. Wiring the create path is the natural
next slice.

`contactRequestDelivery` (staff recipient emails, a contact webhook URL) travels in
the bundle, because spec 079 already classified it `portable` and it is agent
behavior configuration the operator authored. Skill `config` takes the opposite
default — nothing travels unless the capability opts the field in — because
capabilities are an open extension point where a future author could put anything.
The asymmetry is deliberate; if the export file is considered a lower-trust
artifact than the eval snapshots and copilot reads that consume `AgentConfig`
today, `contactRequestDelivery` is the field to reclassify, and that change reaches
those consumers too.

## Two settings `AgentConfig` did not carry

Checking the bundle against `AgentBehaviorSettings` found two fields absent from
the v3 projection. Both are now serialized, without a schema-version bump: adding
an optional field is backward-compatible, and the reader defaults it exactly the
way `authoredDirectives[].enabled` already does.

- **`internalName`** — the operator-facing label. Settable over HTTP today
  (`agentRoutes.ts:115`), so an agent that had one lost it on export/import, and
  loses it in eval replay.
- **`handoffOnRetrievalMiss`** — whether a retrieval miss asks for a human, read
  at turn time by `chat/services/handoffOwnership.ts:79`. No route or service
  writes it, so it is currently unreachable rather than actively lost; carrying it
  means the setting is not left behind the moment a writer appears. That missing
  writer is worth an issue of its own.

Both also reach eval replay through `materializeAgentFromConfig`, so this closes a
replay-fidelity gap that predates this feature.

## Non-portable skill config is reported, not just omitted

Reviewing the capability portability markings exposed a hole in the first cut of
this design: a config field the capability does not mark portable was simply
absent from the bundle, and nothing told the importer. That is the same
silent-behavior-loss failure the `unresolved` report exists to prevent, arriving
through a different door.

`AgentBundleSkill` therefore carries `omittedConfigKeys` — the key *names* the
export left behind, never their values. Naming a field is already public (the
capability descriptor declares it, and the copilot reader names every field to Ray
regardless of `showValueToCopilot`); only the value is sensitive. Import turns each
one into a `skill_config_not_portable` entry.

With omission now visible, the free-text retrieve fields (`instruction`,
`semanticRewriteInstructions`, `lexicalRewriteInstructions`) are marked portable:
they are operator-authored behavior of the same class as the agent's own
`customInstruction`, which has always been portable, and an agent that arrives
without its retrieval instruction answers differently from the one it was taken
from. `sourceScope` and `metadataRules` stay non-portable — they name rows that
exist in one workspace only.

## Two defects review found

Both were invisible to the tests as first written, and both are the same shape: a
promise the design makes, broken at a seam the tests did not cross.

1. **Directives were written before skills.** `AuthoredDirectiveService` validates
   `binding.skillName` against the agent's skills, so any agent with a skill-bound
   directive failed to import outright — and because directive writes were fatal,
   the compensating delete threw the whole import away. Skills now go first (a
   routine's `toolRef` and an enablement's resolver name one too, so the ordering
   was already half-right and the directive case was simply missed). A directive
   whose binding still cannot be satisfied is written **disabled** and reported as
   `directive_binding_unbound`, rather than being dropped or made fatal: the
   directive service skips binding validation for a disabled directive, so the
   retry defers to its rules instead of restating them.
2. **The transport schema silently narrowed the bundle.** `agentBundleBodySchema`'s
   nested element objects were plain `z.object`, which strips unknown keys, so
   `omittedConfigKeys` never reached the import service and the whole
   `skill_config_not_portable` report vanished over HTTP. Every service-level test
   still passed, because they call the service directly, and the e2e mocked the
   backend. Every object in that schema now passes unknown keys through: the route
   exists to reject a body that is not a bundle, not to decide which bundle fields
   survive.

The gap both slipped through was that nothing exercised **HTTP → real services**
together. `agent-bundle-routes.test.ts` now round-trips a skill-bound directive and
a skill with workspace-bound config through the actual endpoints, and
`agent-bundle-route-schema.test.ts` guards the schema against re-narrowing.

## Review findings addressed

Beyond the two defects above, review found four more:

1. **Export was driven by the capability's declared `settingsFields`, not by the
   config actually stored.** `email` declares only `mode` while its config schema
   carries the `boundInputs`/`exposedInputs` field routing an operator authored, so
   that routing was dropped *and* left out of `omittedConfigKeys` — silent loss
   through a second door. Export now also walks the stored config and names every
   key no capability declared. Undeclared means unjudged, and unjudged never
   travels.
2. **No observability at all.** The feature had no log line anywhere, and the
   compensating delete swallowed its own failure with `.catch(() => undefined)` —
   so a failed compensation left a half-built agent in the workspace with nothing
   pointing at it. The delete failure is now logged with the orphaned agent id, a
   successful import logs counts (never contents), and the route records an
   `agent.bundle.imported` audit event with `eventStatus: "failure"` so a refused
   import is not invisible next to the successes.
3. **`stripPlaceholders` dropped whole array elements** when any nested field held a
   placeholder, while the object branch dropped only the offending key. Dormant
   today (both placeholder-bearing arrays are homogeneous), but the wrong default
   for the next array-of-objects field. The array branch now matches the object
   branch.
4. **Composition imported two services from their internal paths** rather than the
   agents module's `public.ts`, unlike the other four dependencies in the same file.

Also corrected: the README and this plan claimed `domain.ts` holds a Zod schema for
the bundle. It does not — the only runtime shape check is the deliberately loose
`agentBundleBodySchema` at the route.
