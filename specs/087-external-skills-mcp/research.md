# Phase 0 Research: External Skills via MCP

## Decision: MCP client = official `@modelcontextprotocol/sdk` v1 (client side)

- **Decision**: Integrate the official MCP TypeScript SDK **v1** (`@modelcontextprotocol/sdk`), importing the client from `@modelcontextprotocol/sdk/client/...`. Use its Streamable HTTP transport + OAuth client helpers.
- **Rationale**: v1.x is the production-recommended line; it provides Streamable HTTP + OAuth, which the bundled `packages/conversation-tools/src/mcpAdapter.ts` (HTTP JSON-RPC only, no sessions/OAuth) lacks. The v2 split packages (`@modelcontextprotocol/client`/`server`) are pre-alpha until ~Q3 2026.
- **Alternatives considered**: (a) extend the hand-rolled JSON-RPC adapter — rejected: re-implements Streamable HTTP + OAuth that the SDK already ships; (b) v2 split packages — rejected: pre-alpha, breaking changes; (c) Vercel AI SDK / LangChain MCP adapters — rejected: drags an unrelated framework.
- **Note**: `packages/radioso-mcp-server` rides `@modelcontextprotocol/server@2.0.0-alpha` (the inbound *server*, independent). A v1 outbound *client* coexists fine; plan a deferred convergence to v2 when stable. Import-path gotcha: v1 client is `@modelcontextprotocol/sdk/client/...`, NOT `@modelcontextprotocol/client`.

## Decision: invoke behind the existing `SkillExecutorPort` (peer to retrieval)

- **Decision**: The MCP skill executor implements the existing `SkillExecutorPort` (`packages/conversation-defaults/src/skillExecutorRegistry.ts`) and is registered via `applicationModule.registerSkillExecutor(...)`, mirroring `backend/src/modules/retrieval/services/retrievalAnswerSkillExecutor.ts`. Reuse `ToolSkillBridge` (`packages/conversation-tools/src/skillBridge.ts`) unchanged — it depends only on the `ToolService` interface.
- **Rationale**: Spike confirmed the bridge is transport-agnostic and that MCP tools already surface as `{kind:"internal", adapter:...}` skills (no new descriptor kind). The engine/routine runner branch on `RoutineSkillResult.status` and never see MCP.
- **Alternatives considered**: new `SkillExecutorDescriptor` kind (`mcp_client`) — rejected as unnecessary; async outbox action path — rejected: fire-and-forget, cannot react to the result inline.

## Decision: auth sliced (token P1, OAuth P2) — spine is auth-agnostic

- **Decision**: Model `authMethod` on the connection; P1 implements static bearer/access-token; P2 adds OAuth 2.1 authorization-code with stored, auto-refreshed tokens. The `ToolService` receives resolved credentials from the connection, so the spine does not depend on which method.
- **Rationale**: Lets the generic spine land + be tested against a mock server without OAuth scaffolding, while keeping OAuth a clean additive slice.
- **⚠️ Flagged for EM**: real Slack/Cal.com MCP servers are OAuth-only, so demoing against them requires pulling P2 into the first increment. Architecture-neutral; delivery-order decision.

## Decision: outcome derivation = coarse first, generic interpretation for fine-grained

- **Decision**: P1 maps MCP `isError` → `failed`, else `completed` (already done by the bridge/ToolService). P3 adds a generic, language-neutral classifier (default) that derives a named outcome from the tool result, plus an optional declarative per-skill outcome map for determinism.
- **Rationale**: Coarse branching is free and covers many skills. Fine-grained meanings (slot_conflict vs no_slots) live in result payloads in service-specific shapes; a model-assisted classifier keeps it integration-agnostic and multilingual (no English keyword lists). The classifier prompt asset lives under `backend/prompts/`.
- **Alternatives considered**: regex/keyword mapping — rejected (English-only, violates multilingual rule); per-integration code — rejected (defeats data-driven goal).

## Decision: secrets via existing field encryption

- **Decision**: Reuse `backend/src/shared/infra/crypto/fieldEncryption.ts` (AES-256-GCM) + operator key for credential columns; never store tokens in per-agent `skillSettings`.
- **Rationale**: Solved problem; no new crypto. Non-secret config (server URL, tool name, bound params) is plain.

## Decision: testing via a generic mock MCP server fixture

- **Decision**: Provide an in-process mock MCP server fixture (configurable tools, schemas, success/error/conflict responses) used by ToolService, executor, resolver, and routine integration tests. No provider-specific code.
- **Rationale**: Deterministic, offline, integration-agnostic; lets US1/US3 be tested without real Slack/Cal.com.

## Message-Queue Impact Review

- **Finding**: This feature performs **synchronous, in-turn** outbound calls behind the skill port. It does NOT add or change worker jobs, AMQP payloads, document-worker dispatch, or retry semantics. The inbound MCP *server* contract (`packages/radioso-mcp-server`) is unaffected (this is an outbound client).
- **Action**: No queue changes expected. Re-confirm during implementation; if any async path is introduced, add queue payload/test/doc tasks.
