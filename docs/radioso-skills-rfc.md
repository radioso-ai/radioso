---
title: "Radioso Skills Vocabulary and Catalog"
description: "The shipped skills model: how Radioso describes grounded work as discoverable, capability-checked, diagnosable skills with a read-only catalog."
last_updated: 2026-09-01
---

# Radioso Skills Vocabulary and Catalog

Audience: product, architecture, backend, SDK, MCP.

Radioso treats grounded work as skills, not only as chat or retrieval endpoints. Skills give assistants, MCP clients, SDK users, and embeds a common way to discover and run useful workspace-grounded work while keeping permissions, diagnostics, and public contracts clear.

This page defines the vocabulary and shows how the shipped pieces fit together. It is not one implementation plan; the model spans several focused areas of the codebase.

## Customer Value

Radioso lets AI applications discover what a workspace can safely do, choose the right grounded work surface, and inspect why the system behaved the way it did.

A caller discovers which Radioso surface to use at request time. Assistant chat, retrieval answer, retrieval search, and MCP tools each expose useful work, and the skills catalog describes them as one coherent workspace contract.

An SDK or MCP client can discover that a workspace supports `retrieval.answer`, see that it requires document-read capability, understand that the stable execution path is the retrieval answer endpoint, and receive diagnostics that explain which retrieval shape and step overrides ran.

Customers build against a workspace that says what it can do, enforces what it is allowed to do, and explains what happened after each grounded action.

## Core Idea

A skill is a durable product-facing unit of work.

Examples include:

- answer from documents
- search documents
- summarize a policy
- contact a human
- create or update a ticket
- send a transactional email

Some skills are interactive. Some are background or administrative. Some are deterministic once selected. Others use probabilistic planning or ranking internally.

Whatever the internals, the caller learns what was attempted, what contract was used, and why the system chose a particular execution path.

## Vocabulary

Use these terms consistently.

| Term | Meaning | Example |
|---|---|---|
| Skill | Product-facing unit of work that a caller can discover or invoke | `retrieval.answer`, `retrieval.search`, `human_contact.request` |
| Capability | Internal permission or runtime primitive used to allow, deny, or compose work | document read, retrieval answer, email delivery |
| Intent | A routing or classification signal derived from input | definition lookup, support handoff, unsupported social turn |
| Shape | A named partial specialization of a skill definition | definition lookup, event/date lookup, broad semantic summary |
| Step | A typed data-only clause inside a skill definition | candidate retrieval, context selection, delivery dispatch |
| Agent | One possible caller or orchestrator of skills | assistant chat, MCP client, SDK integration |

In practice, skills are the public product model. Capabilities are the internal control model. Intents help choose a path. Shapes and steps describe how a chosen skill run is resolved.

Do not use intent as the durable product abstraction. Intent is useful, but it is too close to classification. Radioso needs a model that also covers deterministic work and explicit integrations.

## Relationship To Current Surfaces

Radioso already has several proto-skills:

- retrieval search
- retrieval answer
- assistant chat
- contact request routines
- password reset email delivery
- document ingestion
- MCP capability discovery and tool execution

The skills model does not replace these surfaces with a generic executor. Existing public contracts stay stable, and the skills model describes them:

- Assistant chat can select and call skills when it needs workspace-grounded work.
- Retrieval-only clients keep using retrieval contracts directly.
- MCP describes and exposes available skills without forcing every tool through assistant chat.
- SDK users discover what the workspace can do before choosing a specific endpoint.

## Deterministic And Probabilistic Execution

Skills execute in different modes.

Deterministic skills run a known action once selected. Examples include sending a password reset email, submitting a human contact request, or deleting a document after authorization.

Probabilistic skills may use LLMs, classifiers, ranking, or reranking as part of selection or execution. Retrieval answer is the main example. It may classify the query shape, rewrite the query, resolve a retrieval shape, rerank candidates, and synthesize a grounded response.

The system does not hide probabilistic behavior. A skill execution exposes enough metadata for operators and developers to inspect what happened.

## Retrieval As The Shape-Aware Skill

Retrieval is the first shape-aware skill, because it already has multiple execution shapes.

Grounded questions are not one broad retrieval problem. In practice, query shape matters.

Shapes for `retrieval.answer`:

| Shape | Best for | Likely behavior |
|---|---|---|
| `definition_lookup` | entity, term, acronym, or concept identification | lexical-heavy search, semantic assist, minimal or no reranking unless ambiguous |
| `event_date_lookup` | event, schedule, deadline, or date/time answers | keyword and entity boosting, date signal extraction, reranking, stricter evidence checks |
| `policy_answer` | procedural, compliance, or support answers | hybrid search, citations, conservative answer synthesis |
| `exploratory_summary` | broad synthesis, overview, or comparison answers | broader candidate pool, diversity, synthesis across sources |
| `follow_up_grounding` | conversational follow-ups | context-aware rewrite before search, then shape resolution |

These shapes are not user-facing promises. They are an internal execution model: a caller does not select a shape through the API.

`retrieval.answer` selects one of these shapes from language-neutral structured query interpretation metadata and existing continuity metadata, then resolves the skill steps by merging default step clauses with the selected shape's partial overrides. The selected shape and safe resolved-step summary are exposed through the `activityTrace` response, `activitySummary`, and the activity/debug graph. There is no generic skill execution endpoint and no separate trace store.

## Skill Diagnostics

Every skill execution is inspectable.

At minimum, diagnostics include:

- selected skill
- selected shape, when applicable
- resolved step overrides, when applicable
- whether selection was deterministic or probabilistic
- selection confidence or reason, when available
- capability checks applied
- retrieval, ranking, or tool parameters that materially affected the result
- fallback path
- support or evidence status
- caller surface, such as assistant, retrieval API, SDK, or MCP

Diagnostics are part of the product value. They keep expansion from becoming opaque.

For retrieval answer, the operator-facing diagnostic surface is the shared activity trace graph. Runs include a `shape_selection` stage and summary fields such as `shapeName`, `queryShape`, `resolvedSteps`, and `skillDiagnostic`. The same trace is stored in the existing audit-backed chat or search history metadata when those surfaces already persist activity debug data.

## Skill Catalog

The catalog contract is descriptive. It exposes:

```http
GET /api/v1/skills
GET /api/v1/skills/{skillName}
```

A catalog entry can describe:

- skill name
- purpose
- owner module
- supported caller surfaces
- required capabilities
- execution class, such as interactive or deferred
- whether shape diagnostics are available
- supported steps and shapes, when a skill definition exists
- related stable endpoints

The catalog describes existing public contracts rather than adding a generic execution path. It is useful only if it describes real callable work, so it is kept tied to the API, SDK, and MCP server rather than becoming a static taxonomy page.

The `retrieval.answer` entry identifies the related stable endpoint, the required capability, the supported caller surfaces, and whether shape diagnostics are available. It also makes clear that callers do not need to switch to a new execution endpoint to benefit from the skills model.

In practice, the catalog helps a caller answer three questions:

- What can this workspace do?
- What permission is required?
- Which stable contract should I call?

## Built-In Skills

Built-in catalog entries include:

| Skill | Owner | Current contract |
|---|---|---|
| `assistant.chat` | assistant | `POST /api/v1/assistant/chat` |
| `retrieval.search` | retrieval | `POST /api/v1/retrieval/search` |
| `retrieval.answer` | retrieval | `POST /api/v1/retrieval/answer` |
| `documents.ingest` | documents | `POST /api/v1/document` |
| `documents.search` | documents | `POST /api/v1/document/search` |
| `documents.delete` | documents | `DELETE /api/v1/document/{documentId}` |

These entries are discovery metadata. Callers still use the listed existing contracts to perform work.

Contact requests are handled by the built-in chat routine and `contact.send` action handler. The public chat button uses `human_contact.request` as its intake action identifier, but that identifier is not an Enterprise skill catalog entry.

## Skill Definitions

A skill definition is data, not an executor. It contains stable catalog metadata, typed step definitions, optional named shapes, and partial step overrides. A resolver combines the default step clauses with the selected shape's overrides and returns a resolved run that execution services can inspect.

For `retrieval.answer`, the retrieval pipeline owns query interpretation, candidate retrieval, context selection, prompt assembly, and diagnostics. The skill definition only describes those steps and the shape-specific clauses. For example, `definition_lookup` overrides the `context_selection` step so rerank is disabled and lexical bias is preferred; the context-selection stage reads that resolved clause instead of checking the shape name directly.

For contact requests, the chat routine owns field collection and emits a durable `contact.send` action. The action handler owns delivery. This keeps the flow inside the normal turn spine without a generic `POST /skills/{name}/execute` surface.

The direct contact draft and submit routes are intentionally retired. Human contact enters through normal chat messages or the public chat `human_contact.request` intent click, then the built-in contact routine collects the required fields and emits `contact.send`.

A chat suggestion may carry an optional `action`. When `action.kind` is `"start_intent"`, the suggestion is an entry chip for a structured workflow rather than a free-text follow-up question. Clients activate the chip by sending the chip text with `inputMetadata.method = "intent_click"` and the `intent` object verbatim; the registered routine or intake provider receives the structured trigger and runs through the normal chat turn spine.

Action chips do not own execution. The chip is a hint surface that starts a workflow; all validation, permissions, state, side effects, and audit remain with the routine, action handler, or intake provider. Modules contribute chips by registering a `ChatActionSuggestionProvider`, which is evaluated against the skill-owned turn outcome (for example, `retrieval.answer` with `no_context`) and normalized status, then returns at most one chip per turn.

## Skill Intake And Execution

Some skills can be started from natural chat and need the assistant surface to collect typed inputs before execution. These skills may declare an optional `intake` block alongside their catalog metadata.

A skill definition uses the same interface for retrieval, webhooks, and external integrations:

- `intake` describes fields that must be available before execution, how interruption should work, and whether confirmation is required.
- `execution` describes the adapter that runs after required intake is valid, such as an internal retrieval adapter, a webhook, or a durable delivery pipeline.

The LLM may propose field candidates from user language, but deterministic application code owns required fields, validation, permissions, sensitive-field TTLs, confirmation policy, state transitions, and execution.

For example, `retrieval.answer` declares a `query` intake field and an internal `retrieval_answer` execution adapter. A Make-backed appointment scheduling skill can declare required `email` and `preferred_date` fields, deterministic validators, `pause_and_resume` interruption, and a webhook execution adapter. The chat runtime then asks only for missing or invalid fields before calling the configured webhook.

For `human_contact.request`, execution is a durable delivery pipeline, not an internal service. The submission is accepted and audited, then delivered through the workspace's configured email and/or webhook adapters.

Workspace webhook destinations are the registry side of routine completion export. They store named HTTPS endpoints and encrypted signing secrets once per workspace. Routines reference a destination by stable id. The registry and reference checks do not introduce a new document-worker queue or AMQP queue. The routine engine emits a generic `webhook.send` action when a completion-export-enabled routine reaches a matching terminal. The action handler uses the existing routine action outbox and dispatch worker, signs requests with the destination secret, records latest delivery outcome fields on the destination, and treats missing destinations or disabled agent webhook export as terminal skips.

## Diagnostic Definition

The shared diagnostic definition can represent deterministic and probabilistic skill execution.

Core fields include:

- `skillName`
- `shapeName`
- `selectionMode`
- `selectionReason`
- `selectionConfidence`
- `callerSurface`
- `capabilityChecks`
- `parameters`
- `fallback`
- `outcome`
- `error`
- `evidence`

Retrieval-specific evidence metadata can include query shape, retrieval shape, resolved-step summaries, candidate source summary, ranking choices, evidence status, support status, and grounding outcome.

The catalog exposes whether diagnostics are defined and whether a skill is shape-aware. Retrieval answer emits concrete diagnostic records through its existing trace contract. Other execution features can reuse the vocabulary without changing the trace surface again.

## Non-Goals

The skills model does not:

- replace assistant chat with a generic agent runtime
- force retrieval-only customers through assistant chat
- replace existing public retrieval endpoints
- expose every internal capability as a public skill
- allow unbounded tool use by default

## Design Principle

Radioso makes skills easy to add, but hard to make invisible.

Every expansion preserves:

- stable public contracts
- explicit capability checks
- clear module ownership
- diagnostics for probabilistic decisions
- honest unsupported outcomes
- separation between assistant behavior and retrieval-only behavior

## Open Directions

These ideas are not shipped. They are recorded here so the model stays honest about what exists versus what is deliberately deferred.

### Generic execution endpoint

A generic execution endpoint could be useful:

```http
POST /api/v1/skills/{skillName}/execute
```

It is deliberately not built yet. Generic execution is only worthwhile once Radioso has clear skill definitions, capability checks, diagnostics, and a proven shape-aware skill — which it now does — plus evidence that a single execution surface would not blur the assistant and retrieval boundary the current architecture keeps clear.

Reasonable gates before adding it:

- at least one retrieval skill exposes shape diagnostics through an existing public contract
- at least one deterministic skill is represented in the catalog without special-case vocabulary
- at least two caller surfaces, such as SDK and MCP, consume skill metadata
- capability checks are described consistently between the catalog and runtime enforcement
- operators can debug a failed or unsupported skill execution from diagnostics alone

Until those hold together for a candidate skill, a generic endpoint would mostly hide unfinished product decisions behind a broad surface.
