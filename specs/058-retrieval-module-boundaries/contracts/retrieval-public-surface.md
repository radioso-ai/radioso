# Contract: Retrieval Public Surface

## Purpose

The retrieval public surface is an internal architecture contract. It is not a REST API, SDK surface, MCP contract, queue payload, database schema, or frontend route.

Production code outside `backend/src/modules/retrieval/**` must import retrieval-owned symbols through:

```text
backend/src/modules/retrieval/public.ts
```

## Allowed Consumers

Production consumers may include:

- `backend/src/app/**`
- `backend/src/modules/chat/**`
- `backend/src/modules/documents/**`
- `backend/src/modules/audit/**`
- `backend/src/modules/settings/**`
- `backend/src/db/**`
- `backend/src/shared/infra/llm/**`

## Public Export Categories

The public surface may export:

- Retrieval request and result contracts
- Retrieval trace and diagnostic contracts
- Public retrieval services used by app wiring or adjacent modules
- Chunking contracts and strategy constructors used by ingestion or settings
- Search-text helpers used by document processing
- Subject helpers used by document processing
- LLM gateway adapters used by provider registration
- Retrieval search/vector infrastructure adapters used by app dependency wiring

## Private Retrieval Areas

Production code outside retrieval must not import directly from:

- `backend/src/modules/retrieval/domain/**`
- `backend/src/modules/retrieval/services/**`
- `backend/src/modules/retrieval/infra/**`

Retrieval-internal source may continue using direct internal imports.

Backend tests are excluded from this pilot boundary rule.

## Promotion Rule

When a production consumer needs a retrieval-owned symbol that is not exported publicly, the implementer must choose one of these outcomes:

1. Promote the symbol through `public.ts` because it is an intentional cross-module contract.
2. Refactor the consumer so it no longer needs retrieval internals.
3. Keep the usage retrieval-internal by moving ownership back into retrieval.

## Non-Goals

This contract does not change runtime behavior, HTTP payloads, SDK types, MCP tools, worker messages, database fields, prompts, or frontend routes.
