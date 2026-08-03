---
title: "Usage Event Taxonomy"
description: "Specification of how model inference and embedding operations are tracked and recorded in usage events with surface names and operation lineage."
last_updated: 2026-08-03
---

# Usage Event Taxonomy

Usage events are internal cost and reliability records. They are not customer
billing records.

Model-backed product flows call through `ModelInferencePipeline` or
`EmbeddingInferencePipeline`, not directly through raw provider adapters. The
inference pipelines require operation context and record one `usage_events` row
for each provider attempt when a `UsageEventRecorder` is configured. Product
pipelines own lineage and operation naming. The inference pipelines own provider
usage extraction, estimated fallback usage, and idempotent ledger writes.

Do not record raw prompts, raw responses, document text, or message bodies in
usage events.

## Identity

The recorder contract has one `idempotencyKey`. Model events use this format:

```text
model:{surface}:{operation}:{conversationOrRequest}:{messageOrNone}:{attemptKey}:{provider}:{model}:{status}
```

Embedding events use the same lineage shape with an `embedding` prefix:

```text
embedding:{surface}:{operation}:{conversationOrRequest}:{messageOrNone}:{attemptKey}:{provider}:{model}:{status}
```

`conversationOrRequest` is the conversation id when one exists. Request-scoped
surfaces use `request:{requestId}` instead. `messageOrNone` is the message id
when one exists, otherwise `none`.

Retries that can consume provider resources must use distinct `attemptKey`
values. Replays of the same provider attempt must reuse the same key.

## Recorded Dimensions

Every new pipeline write sets `event_kind` to `model` or `embedding`. The
ledger keeps `unknown` for historic rows whose stored evidence cannot establish
which kind of provider operation created them. Reports keep that usage visible
without folding it into model or embedding totals.

Model events store provider-reported `reasoning_tokens` when the provider
supplies it. A missing value means the provider did not supply a usable
reasoning count; it is not treated as zero. The dashboard uses this distinction
when it reports visible output tokens.

The recorder can also store `agent_id` when the calling product flow knows the
agent. It complements workspace, conversation, message, document, and job
lineage; it does not replace them.

## Current Surfaces And Operations

| Surface | Operation | Caller | Lineage |
|---------|-----------|--------|---------|
| `assistant` | `answer` | Assistant chat answer generation, including grounded and no-context fallback answers | account, workspace, conversation, user message |
| `assistant` | `turn_planning` | Fused assistant turn planning: one chat-tier call replacing turn routing/rewrite, response-language, routine-activation, and directive-match classification on eligible fresh turns (falls back to the staged operations below when absent) | account when available, workspace, conversation, user message |
| `assistant` | `turn_interpretation` | Merged assistant turn routing and retrieval rewrite interpretation | account when available, workspace, conversation, user message |
| `assistant` | `directive_match` | Contextual directive-condition classification for assistant turn steering | account when available, workspace, conversation, user message |
| `assistant` | `turn_router` | Assistant turn routing before retrieval or direct answer selection | account when available, workspace, conversation, user message |
| `assistant` | `routine_activation_embedding` | Routine trigger embedding prefilter before activation ranking | account when available, workspace, conversation, user message |
| `assistant` | `routine_activation` | Routine activation ranking over plausible triggers | account when available, workspace, conversation, user message |
| `assistant` | `response_language_detection` | Assistant per-turn response language detection | account when available, workspace, conversation, user message |
| `assistant` | `bootstrap_greeting` | Assistant bootstrap greeting generation | account when available, workspace, request |
| `retrieval` | `query_interpretation` | Retrieval query rewrite and query interpretation | account when available, workspace, request |
| `retrieval` | `trigger_analysis` | Retrieval metadata trigger analysis | account when available, workspace, request |
| `retrieval` | `query_embedding` | Retrieval semantic query embeddings, including agentic semantic search | account when available, workspace, request |
| `retrieval` | `agent_step` | Agentic retrieval model planning step | account when available, workspace, request |
| `retrieval` | `rerank` | Retrieval model reranking, including agentic rerank tool calls | account when available, workspace, request |
| `retrieval` | `grounded_answer` | Retrieval API grounded answer generation | account when available, workspace, request |
| `mcp_capability` | `query_interpretation` | MCP-backed retrieval answer query interpretation | account when available, workspace, request |
| `mcp_capability` | `trigger_analysis` | MCP-backed retrieval metadata trigger analysis | account when available, workspace, request |
| `mcp_capability` | `query_embedding` | MCP-backed retrieval answer semantic query embeddings | account when available, workspace, request |
| `mcp_capability` | `rerank` | MCP-backed retrieval answer model reranking | account when available, workspace, request |
| `mcp_capability` | `grounded_answer` | MCP-backed retrieval answer generation | account when available, workspace, request |
| `documents` | `query_interpretation` | Document search query rewrite and query interpretation | workspace, search request |
| `documents` | `query_embedding` | Document search semantic query embeddings | workspace, search request |
| `documents` | `rerank` | Document search model reranking | workspace, search request |
| `documents` | `semantic_chunking_embedding` | Document processing semantic chunking embeddings | workspace, document job |
| `documents` | `document_enrichment` | Metadata generation for a processed document | workspace, document, revision |
| `eval` | `query_interpretation` | Eval replay query rewrite and query interpretation | workspace, eval run |
| `eval` | `trigger_analysis` | Eval replay metadata trigger analysis | workspace, eval run |
| `eval` | `query_embedding` | Eval replay semantic query embeddings | workspace, eval run |
| `eval` | `agent_step` | Eval replay agentic retrieval model planning step | workspace, eval run |
| `eval` | `rerank` | Eval replay model reranking | workspace, eval run |
| `eval` | `full_assistant` | Eval replay of full assistant answer generation | workspace, eval run |
| `eval` | `llm_judge` | Eval judge assertions | workspace, eval run |
| `agent_wizard` | `analyze_website` | Agent Wizard website analysis | workspace, analysis request |
| `agents` | `draft_directive` | Drafting a directive from an operator's coaching input | workspace, agent, request |
| `agents` | `directive_coherence` | Checking a proposed directive against the agent's existing directives | workspace, agent |
| `documents` | `embedding` | Document processing chunk embeddings | account when resolvable, workspace, document, revision, job |

## Detailed Usage Reporting

The account Usage screen and its reporting routes read the immutable ledger in
two views. The message view groups visitor-facing user-message activity and
keeps model and embedding subtotals separate. The internal view shows each
other recorded event, including agent setup, test chat, eval, directive work,
metadata generation, and unlinked document processing.

Message rows qualify only when the linked message has role `user`, its
conversation is not `authenticated_chat` or `workbench_replay`, and the event
surface is not `eval`. Every other event belongs in the internal view. This
keeps operator and evaluation work out of visitor-message reporting while
retaining it for account operators.

Detailed reporting returns operation attribution, provider and model names,
token dimensions, attempt status, usage quality, and vector counts. It never
returns prompts, completions, message text, document content, provider request
IDs, idempotency keys, or error details.

## Adding A Model-Backed Operation

Use `ModelInferencePipeline` for text generation and `EmbeddingInferencePipeline`
for embedding batches that belong to a product operation. Declare the operation
context at the product pipeline boundary where account, workspace, conversation,
message, job, or request lineage is known. Raw provider adapters are transports
and should not own product accounting.

Choose a short operation name that describes the model-backed work, not the
implementation detail. For example, use `query_interpretation`, not
`openai_rewrite_call`.

If the operation may retry after a provider attempt, include a stable retry
ordinal or provider-attempt identifier in `attemptKey`.
