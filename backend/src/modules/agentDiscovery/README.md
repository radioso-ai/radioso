# Agent discovery module

Agent discovery turns a public agent id into the documents a visiting agent reads before it
connects: an A2A Agent Card, an MCP server card, and a catalog entry. It owns the document
shapes and nothing else.

Start at `routes.ts` for the three unauthenticated reads, `contracts/agentPublicProfile.ts`
for the one port they share, and `domain/render*.ts` for the documents themselves. Each
renderer is a pure function of one `AgentPublicProfile` and carries its own Zod schema;
`app/http/openapi/schemas/agentCardSchemas.ts` registers those schemas rather than
redefining them, so the published contract and the rendered document cannot drift.

What the module knows: three document shapes, and that an agent's endpoint URL and docs URL
are injected configuration. What it does not know: routines, slots, exposure rules, agent
revisions, workspaces, or the host that served the document. Tool descriptors arrive through
the routines module's published port as a type; `app/composition/agentDiscovery.ts` resolves
the profile from the agent row, its current published release, and `AgentToolCatalogPort`.

`AgentPublicProfilePort.load` returns null for every reason a caller is not entitled to a
document — unknown id, card switched off, agent unpublished, agent deleted — so all four
answer with the same 404 and a caller learns nothing from the difference. It throws when
`PUBLIC_MCP_CONVERSE_URL` is unset: a card that omits the endpoint is not a card, and one
that guesses sends callers somewhere that does not answer.

The documents follow two external specifications. The A2A card is the v0.3.0 Agent Card
shape; the server card is the published MCP server document shape, minus `$schema`, which
the server-card extension has not published. Both are gated against vendored copies of those
schemas in `tests/contract/agent-discovery.contract.test.ts`.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/agentDiscovery tests/contract/agent-discovery.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/agent-discovery.integration.test.ts`
