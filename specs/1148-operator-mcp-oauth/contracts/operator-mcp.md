# Contract: Operator MCP Protected Resource

## Resource and discovery

- Canonical protected resource: `https://<mcp-origin>/operator/mcp`.
- Protected-resource metadata:
  `/.well-known/oauth-protected-resource/operator/mcp`.
- The metadata names the exact resource, Radioso authorization-server issuer,
  Bearer transport, and only the four operator tool scopes.
- Missing/invalid Bearer credentials return `401` and a `WWW-Authenticate`
  challenge with the metadata URL. Insufficient shape scope returns `403` with
  the required single tool scope.

## Request profile

- Protocol version: `2026-07-28` only.
- Stateless JSON-RPC request over HTTP POST; no operator session ID and no
  initialization handshake.
- Supported methods: `server/discover`, `ping`, `tools/list`, `tools/call`.
- Every request mirrors the protocol version and method in
  `MCP-Protocol-Version` and `Mcp-Method` before an unrestricted body is parsed.
  The header values must match the JSON-RPC method and the protocol version in
  `params._meta`; `tools/call` also mirrors `params.name` in `Mcp-Name` before
  parsing bounded arguments and a stable operation identity for stateful
  descriptors.
- Every request carries client capabilities in `params._meta` and may carry
  client identity there. `server/discover` reports the supported version,
  server identity, and tool capability without requiring an initialization
  exchange.
- Responses are JSON only. Tool catalog caching is disabled initially; each
  list is marked grant-private with a zero TTL and rebuilt from current grant,
  client, tenure, role, and descriptor state. Every successful response carries
  `resultType: "complete"`.

## Tool mapping

Each eligible production descriptor maps generically:

- name and description from the descriptor;
- JSON Schema generated from the descriptor's Zod input schema;
- output structured according to the descriptor's bounded output schema plus a
  dashboard handoff where one exists;
- required OAuth scope derived one-to-one from descriptor shape;
- no copied permission, cost, provenance, or safety rules.

Initial limited catalog: `workspace_settings`, `retrieval_probe`, and
`propose_ingestion_settings`. All other production descriptors have explicit
reviewed exclusion reasons. No act is available; therefore GA remains closed.

## Errors

- Protocol parse/shape failure: JSON-RPC invalid-request/invalid-params response.
- Unknown, excluded, stale, or unauthorized descriptor: indistinguishable safe
  not-found/authorization result with no protected detail.
- Budget refusal: bounded retry guidance without exposing counters for another
  user or grant.
- Backend dependency failure: safe unavailable response; existing `/mcp` and
  `ask_agent` continue independently.
