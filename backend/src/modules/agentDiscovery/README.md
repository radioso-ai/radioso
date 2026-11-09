# Agent discovery module

Agent discovery turns a public agent id into the documents a visiting agent reads before it
connects: an A2A Agent Card, an MCP server card, and a catalog entry. It owns the document
shapes and nothing else.

Start at `routes.ts` for the three unauthenticated reads, `contracts/agentPublicProfile.ts`
for the one port they share, and `domain/render*.ts` for the documents themselves. Each
renderer is a pure function of one `AgentPublicProfile` and carries its own Zod schema;
`app/http/openapi/schemas/agentCardSchemas.ts` registers those schemas rather than
redefining them, so the published contract and the rendered document cannot drift.

What the module knows: three document shapes, and that an agent's MCP endpoint URL, A2A
endpoint URL, and docs URL are injected configuration. `discoveryDocumentUrls.ts` builds the
A2A endpoint URL from a public API base (keeping any path prefix on it) and exports the Express
mount path for the A2A route, so the URL a card names and the path a router answers share one
constant; composition owns the base (`app/composition/publicApiBase.ts`) and the mount. What
it does not know: routines, slots, exposure rules, agent revisions, workspaces, or the host
that served the document. Tool descriptors arrive through the routines module's published
port as a type; `app/composition/agentDiscovery.ts` resolves the profile from the agent row,
its current published release, and `AgentToolCatalogPort`.

`AgentPublicProfilePort.load` returns null for every reason a caller is not entitled to a
document — unknown id, card switched off, agent unpublished, agent deleted — so all four
answer with the same 404 and a caller learns nothing from the difference. It throws when
`PUBLIC_MCP_CONVERSE_URL` is unset: a card that omits the endpoint is not a card, and one
that guesses sends callers somewhere that does not answer.

The documents follow two external specifications. The A2A card is the v1.0 Agent Card
shape (`supportedInterfaces`, ProtoJSON `oneof` wrappers for security, no top-level `url`):
one JSON-RPC interface at the A2A endpoint, an `ask_agent` skill first and one skill per
exposed tool, and the Radioso converse extension (`shared/domain/a2aConverseExtension.ts`)
under `capabilities.extensions`, whose params carry the MCP endpoint, the MCP server card
URL, and each tool's input schema because A2A skills carry none. The server card is the
published MCP server document shape, minus `$schema`, which the server-card extension has not
published. Both are gated in `tests/contract/agent-discovery.contract.test.ts`: the server
card against a vendored copy of its published schema, the A2A card against
`tests/fixtures/discovery-schemas/a2a-agent-card-v1.0-derived.schema.json`, which is derived
by hand from `a2a.proto` (v1.0 publishes no card schema) and is deliberately independent of
the renderer's Zod schema. It enforces that required arrays are non-empty.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/agentDiscovery tests/contract/agent-discovery.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/agent-discovery.integration.test.ts`
