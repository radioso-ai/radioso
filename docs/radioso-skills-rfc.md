# Radioso Skills RFC

Status: Draft  
Audience: product, architecture, backend, SDK, MCP

Radioso should treat grounded work as skills, not only as chat or retrieval endpoints.

The goal is to give assistants, MCP clients, SDK users, embeds, and future agents a common way to discover and execute useful workspace-grounded work while keeping permissions, diagnostics, and public contracts clear.

This RFC defines the vocabulary and direction. It is not one implementation plan. The work should span focused specs.

## Customer Promise

Radioso should let AI applications discover what a workspace can safely do, choose the right grounded work surface, and inspect why the system behaved the way it did.

Today, a caller has to know which Radioso surface to use before it makes a request. Assistant chat, retrieval answer, retrieval search, MCP tools, and future integrations each expose useful work, but the product does not yet describe them as one coherent workspace contract.

The skills model should make that contract explicit.

For example, an SDK or MCP client should be able to discover that a workspace supports `retrieval.answer`, see that it requires document-read capability, understand that the stable execution path is still the retrieval answer endpoint, and receive diagnostics that explain which retrieval strategy ran.

The practical value is not a generic agent layer. The practical value is that customers can build against a workspace that says what it can do, enforces what it is allowed to do, and explains what happened after each grounded action.

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

The key point is that the caller should understand what was attempted, what contract was used, and why the system chose a particular execution path.

## Vocabulary

Use these terms consistently.

| Term | Meaning | Example |
|---|---|---|
| Skill | Product-facing unit of work that a caller can discover or invoke | `retrieval.answer`, `retrieval.search`, `human_contact.request` |
| Capability | Internal permission or runtime primitive used to allow, deny, or compose work | document read, retrieval answer, email delivery |
| Intent | A routing or classification signal derived from input | definition lookup, contact human, unsupported social turn |
| Strategy | The execution plan used inside a skill | lexical-heavy lookup, date-aware reranking, broad semantic summary |
| Agent | One possible caller or orchestrator of skills | assistant chat, MCP client, SDK integration |

In practice, skills are the public product model. Capabilities are the internal control model. Intents help choose a path. Strategies describe how a chosen skill runs.

Do not use intent as the durable product abstraction. Intent is useful, but it is too close to classification. Radioso needs a model that also covers deterministic work and explicit integrations.

## Relationship To Current Surfaces

Radioso already has several proto-skills:

- retrieval search
- retrieval answer
- assistant chat
- human contact handoff
- password reset email delivery
- document ingestion
- MCP capability discovery and tool execution

The first implementation should not replace these surfaces with a generic executor. Existing public contracts should remain stable while the skills model is introduced around them.

The skills model should make current contracts easier to describe:

- Assistant chat can select and call skills when it needs workspace-grounded work.
- Retrieval-only clients can keep using retrieval contracts directly.
- MCP can describe and expose available skills without forcing every tool through assistant chat.
- SDK users can discover what the workspace can do before choosing a specific endpoint.

## Deterministic And Probabilistic Execution

Skills may execute in different modes.

Deterministic skills run a known action once selected. Examples include sending a password reset email, submitting a human contact request, or deleting a document after authorization.

Probabilistic skills may use LLMs, classifiers, ranking, or reranking as part of selection or execution. Retrieval answer is the main example. It may classify the query shape, rewrite the query, choose a retrieval strategy, rerank candidates, and synthesize a grounded response.

The system should not hide probabilistic behavior. A skill execution should expose enough metadata for operators and developers to inspect what happened.

## Retrieval As The Pilot Skill

Retrieval should be the first strategy-aware skill because it already has multiple execution shapes.

The current product often treats grounded questions as one broad retrieval problem. In practice, query shape matters.

Example strategies for `retrieval.answer`:

| Strategy | Best for | Likely behavior |
|---|---|---|
| `definition_lookup` | entity, term, acronym, or concept identification | lexical-heavy search, semantic assist, minimal or no reranking unless ambiguous |
| `event_date_lookup` | event, schedule, deadline, or date/time answers | keyword and entity boosting, date signal extraction, reranking, stricter evidence checks |
| `policy_answer` | procedural, compliance, or support answers | hybrid search, support validation, citations, conservative answer synthesis |
| `exploratory_summary` | broad synthesis, overview, or comparison answers | broader candidate pool, diversity, synthesis across sources |
| `follow_up_grounding` | conversational follow-ups | context-aware rewrite before search, then strategy selection |

These strategies should not become user-facing promises until the contracts and diagnostics are ready. They are an internal execution model first.

In the first strategy-aware slice, `retrieval.answer` selects one of these strategies from language-neutral structured query interpretation metadata and existing continuity metadata. The selected strategy is exposed through the existing `retrievalTrace` response and the activity/debug graph. There is no new generic skill execution endpoint and no separate trace store.

## Skill Diagnostics

Every skill execution should be inspectable.

At minimum, diagnostics should include:

- selected skill
- selected strategy, when applicable
- whether selection was deterministic or probabilistic
- selection confidence or reason, when available
- capability checks applied
- retrieval, ranking, or tool parameters that materially affected the result
- fallback path
- support or evidence status
- caller surface, such as assistant, retrieval API, SDK, or MCP

Diagnostics are part of the product value. They keep expansion from becoming opaque.

For retrieval answer, the operator-facing diagnostic surface is the existing retrieval trace graph. New runs include a `strategy_selection` stage and summary fields such as `strategy`, `queryShape`, and `skillDiagnostic`. The same trace is stored in the existing audit-backed chat or search history metadata when those surfaces already persist retrieval debug data.

## Skill Catalog

The first contract is descriptive.

It exposes:

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
- whether strategy diagnostics are available
- related stable endpoints

The catalog does not add generic execution. It describes existing public contracts before a future execution surface exists.

The catalog is useful only if it describes real callable work. It should not become a static taxonomy page disconnected from the API, SDK, or MCP server.

A first useful catalog entry for `retrieval.answer` should identify the related stable endpoint, the required capability, the supported caller surfaces, and whether strategy diagnostics are available. It should also make clear that callers do not need to switch to a new execution endpoint to benefit from the skills model.

In practice, the catalog should help a caller answer three questions:

- What can this workspace do?
- What permission is required?
- Which stable contract should I call?

## Current Built-In Skills

The first catalog includes these built-in entries:

| Skill | Owner | Current contract |
|---|---|---|
| `assistant.chat` | assistant | `POST /api/v1/assistant/chat` |
| `retrieval.search` | retrieval | `POST /api/v1/retrieval/search` |
| `retrieval.answer` | retrieval | `POST /api/v1/retrieval/answer` and MCP `answer_grounded` |
| `documents.ingest` | documents | `POST /api/v1/document` and MCP `create_document` |
| `documents.search` | documents | `POST /api/v1/document/search` and MCP `search_documents` |
| `documents.delete` | documents | `DELETE /api/v1/document/{documentId}` and MCP `delete_document` |
| `mcp.describe_capabilities` | MCP | MCP `describe_capabilities` |

These entries are discovery metadata. Callers still use the listed existing contracts to perform work.

## Diagnostic Definition

The shared diagnostic definition can represent deterministic and probabilistic skill execution.

Core fields include:

- `skillName`
- `strategy`
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

Retrieval-specific evidence metadata can include query shape, retrieval strategy, candidate source summary, ranking choices, evidence status, support status, and grounding outcome.

The catalog exposes whether diagnostics are defined and whether a skill is strategy-aware. Retrieval answer now emits concrete diagnostic records through its existing trace contract. Later execution features can reuse the vocabulary without changing the trace surface again.

## Generic Execution

A generic execution endpoint may be useful later:

```http
POST /api/v1/skills/{skillName}/execute
```

Do not start there.

Generic execution is only useful after Radioso has clear skill definitions, capability checks, diagnostics, and at least one proven strategy-aware skill. If added too early, it can blur the assistant and retrieval boundary that the current architecture is trying to clarify.

Before adding generic execution, Radioso should have evidence that the catalog and diagnostics are already useful through existing surfaces.

Reasonable gates include:

- at least one retrieval skill exposes strategy diagnostics through an existing public contract
- at least one deterministic skill is represented in the catalog without special-case vocabulary
- at least two caller surfaces, such as SDK and MCP, can consume skill metadata
- capability checks are described consistently between the catalog and runtime enforcement
- operators can debug a failed or unsupported skill execution from diagnostics alone

If these gates are not met, generic execution is likely to hide unfinished product decisions behind a broad endpoint.

## Non-Goals

This RFC does not require:

- replacing assistant chat with a generic agent runtime
- forcing retrieval-only customers through assistant chat
- replacing existing public retrieval endpoints
- exposing every internal capability as a public skill
- allowing unbounded tool use by default
- adding external connector workflows as part of the first pass

## Sensible Sequence

The work should proceed in stages.

First, define the skills vocabulary and document how it relates to existing assistant, retrieval, MCP, SDK, and capability-policy contracts.

Second, inventory existing proto-skills and identify which stable endpoint or module owns each one.

Third, add a read-only skill catalog that describes current supported skills without changing execution.

Fourth, make retrieval answer the first strategy-aware skill. Add strategy selection and diagnostics behind the existing retrieval answer contract where possible. This should be the first visible product slice, not only an internal refactor.

This fourth step is intentionally narrow. It adds strategy selection for `retrieval.answer`, emits strategy tags in `retrieval.pipeline.completed` telemetry, and adds strategy metadata to the existing trace graph. It does not make strategies a caller-selected API parameter.

Fifth, let assistant chat and MCP surface skill metadata without forcing all execution through one generic path.

Sixth, represent one narrow deterministic skill in the catalog. Prefer product-native work such as `human_contact.request` before broader external workflows like ticket creation or email delivery.

Finally, consider a generic skill execution endpoint after the model has proven itself with retrieval and at least one deterministic skill.

## Design Principle

Radioso should make skills easy to add, but hard to make invisible.

Every expansion should preserve:

- stable public contracts
- explicit capability checks
- clear module ownership
- diagnostics for probabilistic decisions
- honest unsupported outcomes
- separation between assistant behavior and retrieval-only behavior

That is the difference between a grounded skill runtime and a black-box agent wrapper.
