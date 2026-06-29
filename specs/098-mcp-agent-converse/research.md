# Research: MCP Agent Converse

## Decision: Treat converse as the MCP sibling of public chat, not workspace API token MCP

**Rationale**: The approved spec identifies workspace API tokens as operator credentials and the wrong principal for external clients that should converse with one agent. Reusing `public-launch` plus a new `mcp-converse` channel keeps the launch/exchange lane separate from bearer workspace auth while allowing existing access-grant issuance, hashing/encryption, rotation, revocation, expiry, and audit behavior to remain the source of truth.

**Alternatives considered**:
- Workspace API token: rejected because it authorizes broad workspace actions and currently unlocks document-management MCP tools.
- New credential table: rejected because the spec requires reuse of `agent_access_grants` and there is no new credential lifecycle to invent.
- Inline `scopes[]` on a grant: rejected by the access-grants design; authority remains role-based.

## Decision: Add `channel` and `agent` role to `agent_access_grants`

**Rationale**: Embed/public-link launch tokens are protected by Origin, but MCP clients commonly omit Origin. A hard `channel = mcp-converse` boundary prevents public embed tokens from becoming origin-bypass converse credentials. A new `agent` role allows US2 read-only retrieval/resource permissions without expanding the existing `public` role shared by website embed.

**Alternatives considered**:
- Reuse `public` role: rejected because `public` lacks `public_chat.retrieval.query` and `public_chat.documents.read.scoped`, and adding those would grant website embed more authority.
- Use `agent-api` principal kind: rejected because it is an unwired bearer lane, not a launch/exchange lane.
- Rely on null Origin handling: rejected because absent Origin must not widen authority.

## Decision: Reuse and extend `publicChatSession` for converse sessions

**Rationale**: Public chat already has signed sessions, `publicSessionId`, `agentId`, resume semantics, and conversation continuity. Converse needs the same turn continuity but with stronger validity: embed `grantId` and grant version and re-evaluate the live grant every request.

**Alternatives considered**:
- New token format: rejected as unnecessary and contrary to the spec.
- Stateless TTL-only validation: rejected because revoked/rotated converse secrets must stop within one request.
- Client-supplied conversation id: rejected for US1 because the session owns one server-side conversation and the credential is the agent selector.

## Decision: Backend owns all converse HTTP endpoints

**Rationale**: Session signing, grant lookup/evaluation, account permissions, the agent turn loop, retrieval configuration, and OAuth issuance all need backend secrets and domain services. A backend-owned HTTP contract lets standalone MCP call over HTTP without importing backend modules or holding secrets, while a merged `/mcp` mount can call the same logic in-process behind the same port.

**Alternatives considered**:
- Put converse logic inside `packages/radioso-mcp-server`: rejected because it would duplicate domain behavior and require backend secrets in the transport.
- Share backend modules directly with the MCP package: rejected because it breaks standalone deployability and the approved boundary rule.
- Keep using existing retrieval API for `answer_grounded`: rejected because it uses system defaults rather than agent retrieval configuration.

## Decision: Active delivery order is US1 -> US2 -> US4; US3 is blocked

**Rationale**: US1 proves the core security and conversation loop. US2 adds the read-only agent-aware evidence surface. US4 is an alternate OAuth front door over the same session issuer. US3 depends on signed end-user identity from spec 097 / PR #783, which is not available on this branch.

**Alternatives considered**:
- Implement US3 identity locally: rejected because the spec says to reuse, not rebuild, spec 097.
- Ship OAuth before launch-token exchange: rejected because launch-token exchange is the simpler MVP and OAuth is additive.

## Decision: Document resources are read-only, sanitized MCP resources, not management tools

**Rationale**: US1 denies legacy document-management tools on the public converse path. US2 exposes only agent-visible documents through MCP resources with public-surface sanitization and citation policy enforcement, plus an agent-aware grounded-answer tool using the bound agent's retrieval settings.

**Alternatives considered**:
- Re-enable `list/get/search/create/update/delete/reprocess_document`: rejected because those are workspace management tools.
- Expose internal document/chunk identifiers: rejected because the public surface must not leak internals beyond configured citation policy.

## Decision: Code-first OpenAPI and generated downstream contracts

**Rationale**: The constitution requires backend HTTP contracts to be registered in `backend/src/app/http/openapi/document.ts` and generated artifacts to be synchronized. MCP and SDK clients must follow the generated contract workflow.

**Alternatives considered**:
- Hand-edit `backend/openapi.yaml` or `backend/openapi.json`: rejected because they are generated outputs.
- Keep MCP types hand-maintained: rejected because generated types already exist and drift checks cover them.

## Decision: Message-queue impact is review-only unless discovery finds hidden queue coupling

**Rationale**: Converse exchange, validation, turns, grounded answer, and document resource reads do not change document worker dispatch or AMQP payloads. Existing document processing remains asynchronous, but this feature does not add worker jobs.

**Alternatives considered**:
- Add a new queue for converse turns: rejected for Scope 1 because the spec requires direct agent turn behavior and long-response support, not a new background job contract.
- Change document worker payloads for resource reads: rejected because resources are a read projection over existing processed documents.
