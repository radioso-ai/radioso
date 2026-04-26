# Research: Assistant-Retrieval Boundary

## Decision 1: Create a first-class assistant module instead of extending chat or connector code

**Decision**: Build a new assistant-owned backend module and move human-facing
chat policy into it, rather than treating the assistant as a connector plugin
or continuing to expand `modules/chat`.

**Rationale**:

- The product boundary is no longer "RAG plus exceptions". The assistant owns
  conversation meaning, direct-answer behavior, and the decision to invoke
  retrieval.
- The current `chatService.ts` already mixes retrieval, answer validation,
  direct-answer behavior, and route selection. Adding new endpoints without a
  module extraction would preserve the same coupling under a new URL shape.
- The connector runtime is designed for channel plugins and webhook lifecycle.
  The assistant is a core product domain, not just another inbound transport.

**Alternatives considered**:

- Keep everything inside `modules/chat` and only rename routes:
  rejected because route changes alone would not solve ownership drift.
- Implement the assistant as a connector plugin:
  rejected because webhook/plugin lifecycle is the wrong abstraction for the
  core interaction domain.

## Decision 2: Keep public chat and website embed as transport adapters over the assistant domain

**Decision**: Preserve dedicated public and embed transports, but make them
normalize into the same assistant service contract instead of owning assistant
policy themselves.

**Rationale**:

- Public chat and embed have different auth, session, and origin requirements
  than authenticated dashboard chat.
- The approved spec wants one assistant-owned surface, but that does not require
  every human-facing channel to expose the same external HTTP path.
- Reusing one assistant application contract behind multiple transports gives
  one product behavior model without collapsing all channel-specific concerns
  into one route handler.

**Alternatives considered**:

- Force public chat and embed to call `POST /api/v1/assistant/chat` directly:
  rejected because tokenized public/embed auth and embed origin checks still
  need dedicated transport adapters.
- Leave public chat and embed fully separate:
  rejected because that preserves duplicated chat ownership and blocks the
  assistant extraction.

## Decision 3: Use one shared platform settings resource with independent assistant, retrieval, and channel sections

**Decision**: Replace the assistant-versus-retrieval route split with a shared
`GET/PUT /api/v1/settings` resource that contains separate `assistant`,
`retrieval`, and `channels` sections, while leaving ingestion as its own
subresource.

**Rationale**:

- Operators are configuring one workspace, not browsing two separate admin
  products.
- The spec requires assistant and retrieval sections under one shared contract,
  and public/embed controls still need a home after the general-settings split.
- Current settings ownership is already fragmented: assistant identity lives in
  "general" and conversation behavior lives in retrieval. A single root
  resource is the cleanest way to reassign ownership without changing the
  underlying tables.

**Alternatives considered**:

- Keep `settings/general` and `settings/retrieval` and add aliases:
  rejected because it preserves the mixed ownership model the feature is trying
  to remove.
- Expose only assistant and retrieval sections, with no channel section:
  rejected because anonymous/public/embed configuration would become an awkward
  orphan despite remaining in scope.

## Decision 4: Make `PUT /api/v1/settings` merge-safe instead of destructive

**Decision**: Treat omitted sections and omitted fields as unchanged during
`PUT /api/v1/settings`, and require explicit null or explicit values to clear
nullable fields.

**Rationale**:

- The spec explicitly requires independent updates without resetting untouched
  sections.
- The current frontend settings flows save slices independently. A destructive
  root replacement contract would create accidental resets or require every UI
  save action to fetch and resubmit unrelated sections.
- Merge-safe nested updates preserve the shared resource shape without forcing
  PATCH semantics into the endpoint naming.

**Alternatives considered**:

- Use strict full-resource PUT replacement:
  rejected because it conflicts with the approved merge requirements.
- Introduce PATCH instead:
  rejected because the endpoint contract is already fixed in the approved spec.

## Decision 5: Keep retrieval as a standalone capability and make unsupported retrieval outcomes typed success unions

**Decision**: `POST /api/v1/retrieval/answer` remains directly usable for
headless RAG and MCP clients, and returns a typed unsupported result with HTTP
200 when the request is outside retrieval scope.

**Rationale**:

- Retrieval rewrite, evidence assembly, grounded answer generation, and support
  validation must remain usable without assistant orchestration.
- A typed success union makes client handling deterministic. Retrieval callers
  can inspect `outcome` instead of inferring meaning from transport-level
  failures.
- This preserves the clean boundary: retrieval does not pretend to be the
  assistant, but it also does not force every caller into assistant APIs just to
  learn a request is out of scope.

**Alternatives considered**:

- Force retrieval-only clients through assistant:
  rejected because it collapses the capability boundary.
- Return transport-level 4xx errors for social or identity turns:
  rejected because the spec asked for a typed retrieval-scoped outcome and
  clients benefit from stable response unions.

## Decision 6: Move MCP grounded-answer usage to retrieval, not assistant

**Decision**: MCP remains parallel to assistant and should consume retrieval and
platform endpoints directly by default, including moving `answer_grounded` from
`/api/v1/chat` to `/api/v1/retrieval/answer`.

**Rationale**:

- The current MCP package already acts like a capability surface, not a human
  chat box.
- The user explicitly rejected the idea that MCP should default to assistant.
- Keeping MCP parallel avoids channel-specific chat assumptions from leaking
  into a tooling surface.

**Alternatives considered**:

- Keep MCP mapped to chat and add assistant-only exceptions:
  rejected because it keeps MCP coupled to the old chat/RAG blend.
- Force all MCP tools through assistant:
  rejected because document, settings, and grounded search capabilities do not
  need assistant persona or chat routing.
