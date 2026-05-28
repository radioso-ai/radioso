# Feature Specification: Agent Runtime And Agentic Retrieval

**Feature Branch**: `065-agent-runtime-and-agentic-retrieval`
**Created**: 2026-05-28
**Status**: Draft
**Input**: User direction: "Build an alternative retrieval which is agent-orchestrated rather than deterministic. The agent chooses among tools — query rewrite, lexical search, semantic search, rerank, metadata filter, fetch chunk, fetch document, list by source, get neighbors — and runs additional steps when needed. Define a shared agent runtime in-repo (not a framework like LangGraph) so this agent and the agent wizard can share the same runtime, tool, and budget primitives."

**Scope Note**: This spec covers two coupled deliveries:

1. A small, in-repo `AgentRuntime` port that defines a tool-calling agent loop with explicit budgets, typed tool contracts, and trace events. The port is the substrate; it does not own product behavior.
2. The first concrete use of that port: **Agentic Retrieval**, an inner retrieval agent that returns grounded chunks (not final answers) by orchestrating retrieval primitives as tools. Answer synthesis remains in the assistant layer.

Out of scope: migrating the existing Agent Creation Wizard onto the new runtime (covered in a follow-on spec), durable agent runs across process restarts, plan-then-execute / graph DSL execution, human-in-the-loop interruption, cross-agent shared state, and any LLM-as-judge evaluation of agentic retrieval. Those are explicit anti-goals for v1.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Adaptive Retrieval For Multi-Hop Questions (Priority: P1)

As a workspace operator running an assistant against a corpus where some user questions require multiple retrieval steps (e.g. "find the policy that governs X, then check whether document Y complies"), I want to enable an agentic retrieval mode that decides at runtime which retrieval tools to call and in what order, so the assistant can answer questions that single-pass deterministic retrieval cannot.

**Why this priority**: This is the user-visible reason to build the substrate. Without a concrete grounded-answer improvement on a class of queries the deterministic pipeline fails on, the runtime has no demand pull.

**Independent Test**: Can be tested by enabling agentic retrieval on a workspace, submitting a query whose answer requires two retrieval calls (one to identify the target entity, a second to retrieve facts about that entity), and asserting that (a) the agent issued at least two distinct tool calls visible in the trace, and (b) the returned chunks include evidence from both retrieval steps.

**Acceptance Scenarios**:

1. **Given** a workspace with agentic retrieval enabled and a corpus containing the documents required for a known multi-hop question, **When** the assistant receives that question, **Then** the agentic retrieval pipeline produces a chunk set whose evidence spans the documents reached by each retrieval hop, and the activity trace records each tool call with its inputs and a short rationale.
2. **Given** a workspace with agentic retrieval enabled, **When** a single-hop question is submitted, **Then** the agent terminates within one or two tool calls and returns chunks comparable in quality to the deterministic pipeline for the same query.
3. **Given** an agentic retrieval run that hits the per-query step budget, **When** the budget is exhausted, **Then** the run terminates with whatever chunks it has collected, the trace records `terminated_reason: "step_budget_exhausted"`, and the chunks are still returned to the caller.
4. **Given** an agentic retrieval run where the model emits a tool call referencing an unknown tool name or invalid arguments, **When** the runtime validates the call, **Then** the call is rejected with a structured tool-error message returned to the model, the model is given one chance to recover, and persistent failure terminates the run with `terminated_reason: "tool_validation_failed"`.

---

### User Story 2 - Operator Controls Cost And Latency (Priority: P1)

As a workspace operator, I want to bound the cost and latency of agentic retrieval per query — maximum steps, maximum tokens pulled into agent context, maximum wall time — so I can adopt this mode without unbounded provider spend.

**Why this priority**: Tool-calling agents that re-read top-k chunks across multiple steps are the dominant cost failure mode for this class of system. Budgets must be a first-class operator surface, not an internal default, or the feature is not safe to enable.

**Independent Test**: Can be tested by configuring tight budgets (e.g. `maxSteps: 2`, `maxToolResultTokens: 4000`) on a workspace, submitting a query that would otherwise expand, and asserting that the run terminates at the configured limit and the trace records which budget was hit.

**Acceptance Scenarios**:

1. **Given** retrieval settings with explicit agentic budgets, **When** a run consumes the configured `maxSteps`, `maxToolResultTokens`, or `maxWallTimeMs`, **Then** the run terminates and the trace records `terminated_reason` and the budget value that was hit.
2. **Given** a workspace with no explicit agentic budgets configured, **When** agentic retrieval is enabled, **Then** safe defaults apply (defaults defined under Requirements) and the resolved budget values are visible in the activity trace.
3. **Given** an in-flight agentic run that exceeds `maxWallTimeMs`, **When** the deadline is reached, **Then** any in-flight tool call is allowed to settle and report, the run terminates after the next runtime tick, and partial results collected so far are returned.

---

### User Story 3 - Diagnose Agentic Runs From The Activity Trace (Priority: P1)

As a workspace operator triaging a bad answer, I want the activity trace to show the agent's tool calls, arguments, rationales, and the chunks it ultimately selected, so I can tell whether the failure was in tool choice, tool result quality, or final synthesis.

**Why this priority**: Agentic systems are opaque without observability. Without parity with the existing retrieval diagnostics surface, operators cannot debug or trust the mode.

**Independent Test**: Can be tested by running a query through agentic retrieval and asserting the trace exposes, for each step: tool name, validated arguments, model rationale text, latency, token cost, result summary (count of chunks returned, distinct documents touched), and the final selected chunk set.

**Acceptance Scenarios**:

1. **Given** an agentic retrieval run, **When** the operator opens the trace for the run, **Then** they see an ordered list of steps with tool name, inputs, rationale, latency, and a result summary for each.
2. **Given** an agentic retrieval run that terminated due to a budget or validation error, **When** the operator opens the trace, **Then** the terminating reason and the step at which it occurred are clearly surfaced.
3. **Given** an agentic retrieval run that returned chunks, **When** the operator opens the trace, **Then** they see which step produced each chunk that ended up in the final selected set.

---

### User Story 4 - Default Stays Deterministic (Priority: P1)

As a workspace operator who has tuned the existing deterministic retrieval pipeline, I want agentic retrieval to be a strictly additive mode behind a per-workspace setting, so existing workspaces are not silently changed when this feature ships.

**Why this priority**: The deterministic pipeline is the validated baseline. Replacing it by default would invalidate operator tuning, eval baselines, and existing SLOs.

**Independent Test**: Can be tested by upgrading to the version that ships agentic retrieval, asserting that workspaces with no explicit setting use the deterministic pipeline, and asserting that an existing eval snapshot replayed in retrieval-only mode produces identical chunks to before the upgrade.

**Acceptance Scenarios**:

1. **Given** a workspace upgraded to the version that ships agentic retrieval, **When** no retrieval mode is explicitly configured, **Then** retrieval uses the deterministic pipeline and behavior is byte-identical to the prior version for the same inputs.
2. **Given** an existing eval snapshot captured under the deterministic pipeline, **When** the snapshot is replayed in retrieval-only mode on the upgraded version, **Then** the replay reproduces the original retrieval result.
3. **Given** a workspace where an operator switches retrieval mode from `deterministic` to `agentic`, **When** the change is saved, **Then** subsequent retrieval calls use the agentic pipeline and the change is reflected in the workspace settings audit log.

---

### Edge Cases

- What happens when the underlying LLM provider returns a malformed tool call (e.g. unparseable JSON arguments)?
- What happens when two tool calls in the same step return overlapping chunks?
- What happens when the agent never emits a terminal "I have enough" signal and instead keeps calling tools until the step budget is exhausted? Are the collected chunks still useful, or is empty better?
- What happens when an agentic run is cancelled by the caller mid-step (e.g. user abandons the chat)?
- What happens when a tool result is too large for the model context window (e.g. a `fetch_doc` on a very large document)?
- What happens when the agent calls `fetch_chunk` for a chunk id that does not exist in the workspace?
- What happens if a tool throws because of a downstream provider outage (e.g. embeddings provider 500)?
- What happens when agentic retrieval is enabled and an eval snapshot with `fidelity: full` is replayed — should the replay use the agent path or pin to the original retrieval mode?
- What happens when the runtime is invoked by a non-retrieval consumer (future agent wizard migration) and a retrieval-only tool is mistakenly registered?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and TypeScript.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search; this spec adds no new storage system.
- Backend development MUST follow TDD: tests written and failing before implementation, both for the runtime port and the agentic retrieval implementation.
- Customer data MUST be protected with least-privilege access and secure transmission. Tool calls executed by the runtime inherit the workspace access boundary of the calling request.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, and replaceable runtime adapters. The agent runtime is a shared substrate and MUST NOT reach into module internals; concrete tools belong to their owning module.
- Runtime LLM prompt templates MUST live under `backend/prompts/`. The agent's system prompt and tool-selection guidance are runtime prompts and MUST live there.
- User-facing assistant copy MUST come from the LLM. Agentic retrieval MUST NOT introduce hard-coded English keyword lists, intent regexes, or English-only routing heuristics; tool selection is model-driven, and any structured routing must be expressed as typed configuration.
- Public contract changes MUST update the code-first OpenAPI registry, generated OpenAPI artifacts, SDK types, and relevant docs. Agentic retrieval surfaces additional trace fields and an additional retrieval-settings mode; both are public contract changes.
- Contract changes MUST include message-queue impact review. Agentic retrieval is synchronous in v1 and does not enqueue worker payloads; if future agents need long-running execution, that work belongs in a follow-on spec.
- Documentation MUST be updated to describe the agent runtime concept (briefly, for contributors), the new retrieval mode setting (for operators), and how to read the agentic trace.

## Architecture Constraints *(mandatory)*

- **Boundary Rule (Runtime)**: The agent runtime is a shared substrate. It knows about: a tool catalog (typed input/output), a tool-calling loop against an LLM provider, budgets, trace events, and termination reasons. It MUST NOT know about retrieval, the agent wizard, assistant persona, document storage, chunks, conversations, or any product concept. Concrete tools are owned by their domain module and registered into a per-call tool catalog.
- **Boundary Rule (Agentic Retrieval)**: Agentic retrieval lives inside the retrieval module and is the only place that knows how to translate retrieval primitives into runtime tools. It composes the runtime; it does not extend it.
- **Encapsulation Rule**: Agentic retrieval MUST reuse the same domain services that the deterministic pipeline uses for embeddings, lexical search, vector search, reranking, query rewrite, and chunk fetch. It MUST NOT fork them. Where a service does not currently expose a narrow port suitable for tool wrapping, the right move is to extract the port — not to duplicate the service.
- **Encapsulation Rule (Answer Boundary)**: Agentic retrieval returns the same result shape as the deterministic pipeline (chunks plus diagnostics) — plus an optional structured `retrievalReasoning` field carrying the agent's `finalize.rationale`. It MUST NOT produce final natural-language answers. Final synthesis remains in the assistant layer and in `RetrievalAnswerService`. The assistant layer consumes `retrievalReasoning` as a structured hint when composing its synthesis prompt. This keeps the assistant/retrieval boundary intact (CLAUDE.md Key Architectural Decisions): persona, response identity, response language policy, citation formatting, custom instructions, and suggested questions remain assistant concerns and MUST NOT be encoded into the agent's system prompt.
- **Source Of Truth Rule**: The runtime is stateless across calls. Each agentic retrieval call constructs a fresh runtime instance with the tool catalog, budgets, and prompt resolved from current workspace settings. The runtime MUST NOT persist its own state.
- **Composition Rule**: The runtime port and its default LLM-tool-call implementation are wired in `backend/src/app/composition/`. The runtime port type lives in `backend/src/shared/agent-runtime/`. Domain modules import the port; they MUST NOT import the implementation directly. (Aligns with CLAUDE.md "Application composition owns replaceable runtime wiring.")
- **New Seams Required**:
  - Add `backend/src/shared/agent-runtime/` exporting the `AgentRuntime` port, `AgentTool` contract, `AgentBudgets`, `AgentTraceEvent`, and termination-reason enums.
  - Add `backend/src/modules/retrieval/services/agenticRetrievalPipelineService.ts` implementing `RetrievalPipelineService` via the runtime; gated by retrieval-settings mode.
  - Add a retrieval-mode field to the workspace retrieval settings (`pipelineMode: "deterministic" | "agentic"`), defaulted to `"deterministic"`.
  - Reuse the existing `ActivityTrace`/`ActivityStage`/`ActivityLink` shape for agentic steps (one stage per runtime step, `kind: "agent_tool_call"`, sequence-linked). Add one optional `ActivitySummary.agentic` field to carry run-level metadata. No parallel diagnostics channel; no `agenticSteps` sibling array. The agentic trace must render through the same UI as deterministic traces.
- **Anti-Goals**: Do not import LangGraph, LangChain, LlamaIndex, Mastra, BAML, Inngest, or any agent framework. Do not introduce a graph DSL or plan-then-execute executor. Do not add durable run checkpointing. Do not add cross-agent shared state. Do not introduce a new retrieval result shape; agentic retrieval returns the existing chunk + diagnostics shape. Do not introduce hard-coded English regexes or keyword lists to steer tool selection.

## Requirements *(mandatory)*

### Functional Requirements - Agent Runtime

- **FR-001**: The repo MUST expose an `AgentRuntime` port with a single method `run(input, tools, budgets) -> AgentRunResult`. `input` carries the user-facing query, optional conversation context, and the resolved system prompt id. `tools` is a typed catalog of `AgentTool` entries supplied per call. `budgets` is an explicit `AgentBudgets` record.
- **FR-002**: An `AgentTool` MUST declare: a stable `name`, a human-readable `description` used in the model's tool schema, a Zod `inputSchema`, a Zod `outputSchema`, an `invoke(input, ctx)` function returning a typed result, and an optional `estimatedResultTokens(input)` hint for budget accounting.
- **FR-003**: The runtime MUST enforce, per call: `maxSteps` (default 6, hard ceiling 16), `maxToolResultTokens` (default 12000, hard ceiling 32000) summed across all tool results pulled into model context, and `maxWallTimeMs` (default 30000, hard ceiling 120000). Hard ceilings MUST NOT be overridable from workspace settings.
- **FR-004**: When any budget is hit, the runtime MUST terminate cleanly and return `AgentRunResult` with `terminatedReason` set to the budget that was hit. Partial results collected so far MUST be returned.
- **FR-005**: When the model emits a tool call with an unknown tool name or arguments that fail Zod validation, the runtime MUST return a structured tool-error message to the model on the next step and increment a per-run validation-error counter. On the second consecutive validation failure for the same tool, the runtime MUST terminate the run with `terminatedReason: "tool_validation_failed"`.
- **FR-006**: When a tool's `invoke` throws, the runtime MUST surface a structured tool-error to the model (without the raw stack), allow one recovery step, and terminate with `terminatedReason: "tool_invocation_failed"` if the model immediately retries the same tool with the same arguments.
- **FR-007**: The runtime MUST emit `AgentTraceEvent`s for: `step_started`, `tool_call_validated`, `tool_call_invoked`, `tool_call_completed`, `tool_call_failed`, `model_message`, `budget_check`, `terminated`. Events MUST be opaque to runtime callers and consumed via a `TraceSink` port.
- **FR-008**: The runtime MUST be model-agnostic. The default implementation delegates to a `ModelToolCallingGateway` port whose default adapter uses the existing provider adapter layer (OpenAI / Anthropic). Choice of model is resolved by the caller, not the runtime.
- **FR-009**: The runtime MUST be stateless across calls. It MUST NOT mutate global state, persist transcripts to storage, or share memory across concurrent invocations.
- **FR-010**: The runtime MUST be cancellable via `AbortSignal`. When aborted, the current model call and tool call are allowed to settle if already in flight, no further steps are taken, and the result is returned with `terminatedReason: "cancelled"`.
- **FR-011**: The runtime MUST expose a streaming variant `runStreaming(input, tools, budgets) -> AsyncIterable<AgentTraceEvent> & { result: Promise<AgentRunResult> }` that emits `AgentTraceEvent`s as they occur. The non-streaming `run` is implemented in terms of the streaming variant; both share the same termination and budget semantics. Callers that do not need progress events MAY use `run` and ignore the stream.

### Functional Requirements - Agentic Retrieval

- **FR-020**: A new retrieval-settings field `pipelineMode` MUST be added with values `"deterministic"` and `"agentic"`. The default for new and existing workspaces is `"deterministic"`.
- **FR-021**: When `pipelineMode = "agentic"`, retrieval calls MUST be served by `AgenticRetrievalPipelineService`, which implements the same `RetrievalPipelineService` port as the deterministic pipeline. The public retrieval contract (request and result shape) MUST NOT change.
- **FR-022**: Agentic retrieval MUST expose the following tools to the runtime (registered per call, not globally):
  - `semantic_search(query, topK, metadataFilter?)` → list of `{ chunkId, documentId, title, snippet, score }`. Returns snippets, not full chunk bodies. Default `topK = 5`, hard ceiling `topK = 20`.
  - `lexical_search(query, topK, metadataFilter?)` → same shape as `semantic_search`.
  - `rewrite_query(query, intent?)` → `{ semantic, lexical }` rewritten forms. Intended for the agent to call before search when the original query is ambiguous.
  - `rerank(chunkIds, query)` → reordered `chunkIds` with scores. Operates on already-collected candidates; MUST NOT pull new chunk bodies into context.
  - `metadata_filter_search(filter, topK)` → candidate chunks matching structured metadata without semantic similarity.
  - `list_by_source(sourceId, limit)` → candidate chunks from a specific document or source.
  - `get_neighbors(chunkId, before, after)` → adjacent chunks in the same document, for expanding around a hit.
  - `fetch_chunk(chunkId)` → full chunk body. The only tool that pulls full bodies into agent context. The chunkId MUST already have been surfaced via a prior `semantic_search` or `lexical_search` call in the same run — a per-run chunk registry stores the originating document id and full content, so the agent never needs to track or pass `documentId`. Calls for unknown chunk ids return a structured `unknown_chunk` error and do not hit the database.
  - `fetch_document_outline(documentId)` → titles and section headings only, no body.
- **FR-023**: Tool selection AND query reformulation MUST be entirely model-driven. The agent MAY call `rewrite_query` as a tool, AND MAY also pass arbitrarily reformulated query strings directly to `semantic_search` / `lexical_search` across steps (e.g. naive lexical first, then a BM25-style disjunction, then a full semantic search). Adaptive reformulation across steps is an expected pattern, not a side effect. The agentic implementation MUST NOT contain English regexes, keyword lists, or hard-coded rules to choose tools or rewrite queries.
- **FR-024**: The agentic agent MUST have a terminal action `finalize(selectedChunkIds, rationale)` that signals "I have enough" and produces the chunk set returned to the caller. `rationale` is a short structured note from the agent explaining why those chunks satisfy the query and (for multi-hop queries) which chunk answers which sub-question. `rationale` MUST be flowed into the assistant layer's synthesis prompt as a structured "retrieval reasoning" hint so the assistant can synthesize with awareness of the agent's reasoning — without the agent itself producing user-facing answer prose. If the run terminates by budget instead of `finalize`, the agent's most recently collected chunks (capped by a configurable `fallbackChunkLimit`, default 8) are returned with `rationale: null`.
- **FR-024a**: `finalize` MUST NOT return a natural-language answer string. Answer synthesis, persona, response identity, response language policy, citation formatting, custom instructions, and suggested questions remain owned by the assistant layer. Allowing `finalize` to return answer prose would require the agent's system prompt to encode assistant concerns; this is explicitly rejected. (See Architecture Constraints, Encapsulation Rule — Answer Boundary.)
- **FR-025**: The agentic system prompt MUST live under `backend/prompts/` and MUST be template-rendered with the resolved tool catalog and budget values. The prompt MUST NOT be hard-coded in service code.
- **FR-026**: Default agentic budgets resolved from workspace retrieval settings MUST be: `maxSteps = 6`, `maxToolResultTokens = 12000`, `maxWallTimeMs = 30000`, `defaultSemanticTopK = 5`, `defaultLexicalTopK = 5`, `fallbackChunkLimit = 8`. Operators MAY tune these per workspace within hard ceilings.
- **FR-027**: The agentic pipeline MUST populate the same `ActivityTrace` shape as the deterministic pipeline. Each agent runtime step MUST be recorded as one `ActivityStage` with `kind: "agent_tool_call"`, the tool name and validated input in `inputs`, the result summary and resulting token cost in `outputs` and `metrics`, latency in `metrics.latencyMs`, the model rationale (if any) in `outputs.rationale`, and a `status` drawn from the existing `ActivityStageStatus` enum (`applied` for success, `fallback` for a recoverable validation rejection, `rejected` for terminal validation failure, `failed` for terminal tool invocation failure). Consecutive agent stages MUST be linked with `kind: "sequence"`. A single optional `ActivitySummary.agentic` field MUST capture run-level metadata (`terminatedReason`, `stepsTaken`, `toolResultTokensUsed`, `wallTimeMs`, `resolvedBudgets`, optional `finalRationale`). This is the only shape change to the trace contracts and is strictly additive.
- **FR-027a**: The agentic pipeline MUST expose a streaming variant that emits `ActivityStage` records as each step completes, suitable for the activity-trace UI to render live (FR-011). Stages emitted live MUST be identical in shape to stages on the completed trace; the streaming variant adds no new event type.
- **FR-028**: The agentic pipeline MUST honor `retrievalSettingsOverride` from the eval module the same way the deterministic pipeline does. An eval snapshot captured under one `pipelineMode` and replayed under another MUST be a valid run; the trace MUST clearly indicate which mode was used.
- **FR-029**: Agentic retrieval MUST NOT mutate the source workspace's retrieval settings, agent records, document corpus, or any other persisted state. Runs MUST be safe to execute repeatedly.
- **FR-030**: When agentic retrieval fails (LLM provider error, runtime termination by `tool_validation_failed` or `tool_invocation_failed`), the pipeline MUST return a structured failure that the assistant layer renders as a "no grounded answer" turn — the same failure path the deterministic pipeline already uses for empty retrieval. It MUST NOT silently fall back to the deterministic pipeline; that would mask agentic regressions.

### Key Entities

- **AgentRuntime**: The shared port. Owns the loop; knows nothing about retrieval.
- **AgentTool**: A named, typed callable with Zod input/output schemas and an `invoke` function. Domain-owned, registered per call.
- **AgentBudgets**: Per-call budgets — `maxSteps`, `maxToolResultTokens`, `maxWallTimeMs` — with hard ceilings enforced by the runtime.
- **AgentRunResult**: `{ finalToolResult, terminatedReason, transcriptId, totalTokenCost, stepsTaken }` where `terminatedReason ∈ { "finalized", "step_budget_exhausted", "token_budget_exhausted", "wall_time_exhausted", "tool_validation_failed", "tool_invocation_failed", "cancelled" }`.
- **AgentTraceEvent**: The internal observability event stream consumed by a `TraceSink`. Lossy on the boundary — the consumer decides what to persist.
- **AgenticRetrievalPipelineService**: The retrieval-module concrete that implements `RetrievalPipelineService` using `AgentRuntime` + the retrieval tool catalog. Owned by retrieval, not by the runtime. Exposes both a synchronous variant (matching the existing `RetrievalPipelineService` shape) and a streaming variant for live trace rendering.
- **Pipeline Mode**: A retrieval settings field selecting `deterministic` or `agentic`. Defaults to `deterministic`.
- **Retrieval Reasoning Hint**: The agent's `finalize.rationale`, surfaced on the retrieval result as an optional structured field and consumed by the assistant synthesis prompt. Not user-visible prose; an internal hint that informs synthesis without leaking assistant concerns into the agent.

## Data Model Direction

This spec adds no new tables. It adds fields to existing structures:

- `retrieval_settings` (or whatever record the retrieval-settings module persists today) gains a `pipeline_mode` text column with `CHECK (pipeline_mode IN ('deterministic', 'agentic'))`, defaulted to `'deterministic'`. Tuning fields for agentic budgets MAY be stored as a JSONB column `agentic_budgets` or as discrete columns; either is acceptable provided the defaults from FR-026 are applied when the column is null.
- The `ActivityTrace` JSON shape persisted with assistant turn context (introduced in 064a) MUST accommodate an optional `agenticSteps` array. Because `ActivityTrace` is JSONB-shaped, this is an additive change with no migration.
- No new tables are required for agent transcripts in v1; the trace is the operator-visible record. If full transcripts become useful, that is a follow-on spec.

## API Direction

The public retrieval API contract does not change in request shape. Agentic retrieval is opaque to callers: the existing `/v1/retrieval/search` and `/v1/retrieval/answer` endpoints (and the SDK and MCP equivalents) keep their request shape. The runtime selection is a workspace setting; a per-call "thinking mode" override is a plausible follow-on but explicitly out of scope for v1.

The retrieval result shape gains an optional `retrievalReasoning` field (string, may be null) carrying the agent's `finalize.rationale` when agentic mode produced the result. Clients MUST tolerate its absence (deterministic mode, or agentic runs terminated by budget without `finalize`).

The retrieval settings API gains:

```
GET    /v1/settings/retrieval          -> RetrievalSettingsRecord (adds pipeline_mode, agentic_budgets)
PATCH  /v1/settings/retrieval          { pipelineMode?, agenticBudgets? } -> RetrievalSettingsRecord
```

`agenticBudgets` is an optional object with `maxSteps`, `maxToolResultTokens`, `maxWallTimeMs`, `defaultSemanticTopK`, `defaultLexicalTopK`, `fallbackChunkLimit` — all optional, all bounded by hard ceilings declared in FR-003 and FR-026. Unknown keys MUST be rejected by Zod.

The activity-trace response shape adds one optional `summary.agentic` block (run-level metadata for agentic runs) and a new `ActivityStage.kind` value of `agent_tool_call` for per-step stages. Operators rendering the trace UI MUST tolerate both being absent (deterministic mode). No `agenticSteps` sibling array is added.

No new endpoints are required for the runtime itself; it is an internal substrate.

## Delivery Split

Implementation SHOULD be split into smaller, reviewable scopes:

1. **065a - Agent Runtime Port And Default Implementation**: introduce `backend/src/shared/agent-runtime/` with the port, tool contract, budget contract, trace event types, and a default LLM-tool-calling implementation wired through the existing provider adapter layer. No retrieval surface yet. Ship with unit tests that drive the runtime against a stub `ModelToolCallingGateway` and a synthetic tool catalog covering each termination reason in FR-004 / FR-005 / FR-006 / FR-010.
2. **065b - Retrieval Tool Catalog Ports**: extract narrow ports for each retrieval primitive where they do not already exist as such. This is extraction-only; no behavior change to the deterministic pipeline.

   **As-built scope (resolved during audit, 2026-05-28):** Five of the nine v1 tool primitives already have narrow ports or services suitable for direct wrapping — `VectorSearchPort` (semantic_search), `LexicalSearchPort` (lexical_search), `RerankService` (rerank), `ChunkRepositoryPort.findByIdForDocument` (fetch_chunk), and the existing `QueryRewriteGateway` infrastructure. Only `QueryRewritePort` needed a true extraction in 065b — a narrow `rewrite(query) → { semantic, lexical }` port over the existing gateway, decoupled from the heavy `QueryRewriteService` which bundles eligibility checks, intent routing, subquery planning, and rewrite-policy guardrails the agent does not want.

   The remaining four primitives — `metadata_filter_search`, `list_by_source`, `get_neighbors`, `fetch_document_outline` — have no current implementation in the codebase. Building them is net-new behavior, not extraction, and is deferred to 065c where the agent tool wrappers will surface the exact shape needed. v1 of the agentic catalog may also drop some of these if 065c can deliver the multi-hop story without them; that decision is part of 065c.
3. **065c - Agentic Retrieval Pipeline (Off By Default)**: ship the agent tool catalog, the agentic runner, the trace mapping, the `backend/prompts/agentic-retrieval/system.md` system prompt, and the `pipelineMode` settings field defaulted to `deterministic`. Operators can opt in per workspace. Cover with unit tests (stubbed runtime + tool catalog) and unit tests (real runtime against a stubbed model gateway that emits scripted tool calls).

   **As-built scope (resolved during implementation, 2026-05-28):** 065c was delivered in three sub-slices.
   - **065c.1 — Tool catalog (shipped):** `backend/src/modules/retrieval/services/agenticTools/` with `ChunkRegistry`, `semantic_search`, `lexical_search`, `rewrite_query`, `rerank`, `fetch_chunk`, and `finalize`. Per-run registry pattern so the agent only operates on chunks it has surfaced and `fetch_chunk(chunkId)` resolves without a `documentId` argument. Per-tool ports close over `workspaceId` (security boundary in the closure, not the schema). 18 unit tests.
   - **065c.2 — Agentic runner + trace (shipped):** `AgenticRetrievalRunner` orchestrates the runtime + tool catalog and emits an `ActivityTrace` whose stages have `kind: "agent_tool_call"`, sequence-linked, plus an `ActivitySummary.agentic` block. The finalize rationale lands on the finalize stage's `outputs.rationale`. 8 unit tests covering happy path, multi-hop (search → rewrite → search → finalize), budget exhaustion with fallback selection, validation-failure termination, and premature-finalize rejection.
   - **065c.3 — Settings field + system prompt (shipped):** `pipelineMode: "deterministic" | "agentic"` added to `RetrievalSettingsRecord` and `RetrievalSettingsInput` as an optional field (defaults to `deterministic` via `resolvePipelineMode`), plumbed through `defaultRetrievalSettings`, `validateRetrievalSettings`, and `freezeRetrievalSettings`. System prompt template at `backend/prompts/agentic-retrieval/system.md`. 7 unit tests.

   **Deferred to follow-on slices (not yet shipped):**
   - **065c.4 — `RetrievalPipelineService` shell**: an `AgenticRetrievalPipelineService` that implements the full `RetrievalPipelineService` interface (`run`/`interpret`/`runInterpreted`/`runWithoutRetrieval`) by composing the runner with a deterministic instance for interpretation, prompt assembly, response identity/settings, and the `runWithoutRetrieval` path. This is the actual seam between the agentic runner and the existing chat pipeline.
   - **065c.5 — Real `ModelToolCallingGateway` adapter**: the runtime currently runs against a stubbed gateway in tests. Need a provider adapter (OpenAI / Anthropic native tool-calling) so agentic mode can run against a real LLM.
   - **065c.6 — Persistence + transport**: a database migration adds `pipeline_mode` to the `retrieval_settings` table; `RetrievalSettingsRepository` read/write paths serialize the field; OpenAPI / SDK / frontend settings UI surface it. Without this, operators can read `pipelineMode` defaults but can't actually persist a non-default value.
   - **065c.7 — Composition switch**: `defaultComposition.ts` selects `AgenticRetrievalPipelineService` vs the deterministic one per workspace setting.

   The order is roughly c.4 → c.5 → c.6 → c.7. c.4 and c.5 are independently buildable; c.6 and c.7 unlock the operator-visible path.
4. **065d - Live Activity Trace UI For Agentic Steps**: render `agenticSteps` live as they happen by consuming the streaming variant (FR-011, FR-027a). Per step show tool name, inputs, terse rationale, latency, and result summary. Render a brief operator-readable progress summary (e.g. "step 2/6 · lexical_search · 3 candidates") so operators can watch the run unfold rather than waiting for completion. Playwright coverage for the visible trace UI, including a scripted scenario that verifies live updates land in order.
5. **065e - Docs And SDK**: update operator docs (when to enable, how to read the trace, budget tuning), update SDK types for the new retrieval-settings fields and trace shape, regenerate OpenAPI.

A follow-on spec MAY migrate the Agent Creation Wizard onto `AgentRuntime`; that work is NOT in this spec because (a) the wizard's runtime needs are not yet fully understood and (b) shipping the substrate against one concrete consumer first is healthier than shipping it against two simultaneously.

## Assumptions

- The existing provider adapter layer can be wrapped to expose a `ModelToolCallingGateway` port without a major refactor. If it cannot, port extraction is part of 065a, not a separate spec.
- Each retrieval primitive listed in FR-022 already exists as a service in the retrieval module or can be cleanly exposed as a port without behavior change. The retrieval `services/` directory inventory suggests this is true (`embeddingService`, `rerankService`, `queryRewriteService`, `retrievalSearchService`, lexical/vector search infra). 065b is the place to validate this assumption per-tool.
- Operators tuning agentic budgets understand the tradeoff between recall and cost. The settings UI MUST surface this with copy; LLM-driven, not hard-coded English in code paths.
- The activity-trace UI in the frontend can absorb an additional optional section without a substrate change. If not, 065d ships the substrate change.
- Volume of agentic runs is low enough that synchronous in-process execution is acceptable. If that ceases to hold, a follow-on spec introduces async dispatch via the existing message-queue substrate.
- Eval snapshots captured before this feature ships are replayed under the workspace's *current* `pipelineMode`, not pinned to the original mode. This is consistent with how the existing eval module treats current corpus state (064 Source Of Truth Rule). If operators need to pin mode per snapshot, that is a follow-on.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workspace with `pipelineMode = "agentic"` can answer a known multi-hop benchmark question that the deterministic pipeline fails on, with all evidence drawn from real corpus chunks, and the agent's tool calls are visible in the activity trace.
- **SC-002**: A workspace with `pipelineMode = "deterministic"` (the default for all existing workspaces) is byte-identical in retrieval behavior to the prior release; this is verified by replaying a corpus of eval snapshots against the upgraded build and asserting chunk-set equality.
- **SC-003**: An agentic retrieval call with default budgets terminates within `maxWallTimeMs` on the 95th percentile across a benchmark set, with median step count ≤ 3 for single-hop queries and ≤ 5 for multi-hop queries. (Benchmark set construction is part of 065c.)
- **SC-004**: When any budget is exceeded, the run terminates cleanly with a structured `terminatedReason`, returns whatever chunks were collected up to `fallbackChunkLimit`, and the trace records which budget was hit. Verified by unit tests that drive each budget to exhaustion.
- **SC-005**: The agent runtime is consumed only via its port from outside `backend/src/shared/agent-runtime/`. Verified by a lint or import-boundary test that fails if a domain module imports a runtime implementation file directly.
- **SC-006**: The agentic retrieval implementation reuses the same embedding, search, rerank, query-rewrite, and chunk-fetch services as the deterministic pipeline. Verified by a structural test that asserts no duplicate service classes exist for these concerns.
- **SC-007**: No file under `backend/src/modules/retrieval/services/agentic*` and no file under `backend/src/shared/agent-runtime/` contains English keyword lists or English-language regexes used to steer tool selection or query interpretation. Verified by code review and a focused lint rule if practical.
- **SC-008**: OpenAPI, SDK types, and operator docs ship in the same change as the retrieval-settings fields they describe (065c and 065e).
- **SC-009**: A follow-on spec can migrate the Agent Creation Wizard onto `AgentRuntime` without modifying the runtime port. Verified at the time of that migration; this spec's success is partial if the port shape needs revision to absorb a second consumer.

## Resolved Design Decisions

The following questions were raised during spec drafting and resolved before approval. Recorded here so the rationale is durable.

- **Query rewrite is a tool, and the agent can also reformulate queries directly across steps.** The agent has more conversation context than any single tool invocation can. Expected pattern: naive lexical search first, then a BM25-style disjunction on extracted entities if results are weak, then a full semantic search. Encoded in FR-022 and FR-023. Pre-loop rewrite was rejected as too rigid for the multi-hop cases that justify this feature.
- **`finalize` does not return an answer string.** The agent emits chunk ids plus a structured `rationale`; the rationale flows into the assistant layer's synthesis prompt as a hint. Letting the agent draft answer prose would force its system prompt to encode persona, response identity, language policy, citation formatting, custom instructions, and suggested questions — collapsing the assistant/retrieval boundary CLAUDE.md preserves. Encoded in FR-024, FR-024a, and the Encapsulation Rule (Answer Boundary). The compromise (rationale flow) captures the agent's multi-hop reasoning where it matters without exposing the agent to assistant concerns. Reversible: if operators later report that synthesis is losing the agent's reasoning, expanding `finalize` is an additive change.
- **Agentic retrieval is workspace-level, not per-call.** It is an inner alternative to the fixed-path retrieval with the same inputs and outputs; the caller does not know which mode ran. A per-call "thinking mode" override is a plausible follow-on but explicitly deferred. Encoded in API Direction.
- **The runtime exposes a streaming variant, and the activity trace UI renders steps live.** Agentic runs take long enough that watching steps land is materially better debug UX than waiting for completion. Encoded in FR-011, FR-027a, and the revised 065d delivery split.
