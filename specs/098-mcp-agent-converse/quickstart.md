# Quickstart: MCP Agent Converse

This quickstart is for validating the implemented feature. It is not executable until tasks are implemented.

## Prerequisites

- Radioso backend, frontend, database, and worker running through the normal dev stack.
- A workspace with one test agent named `Claudio`.
- The agent has persona/directives/routines configured so parity with in-product chat is visible.
- For US2, the agent has non-default retrieval settings and at least two documents where only one is in the agent's visible scope.
- For US4, an MCP OAuth-capable connector or test harness.

## US1: Launch Token Exchange and `ask_agent`

1. Issue an MCP converse grant for `Claudio`.
2. Confirm the grant row has:
   - `principal_kind = public-launch`
   - `channel = mcp-converse`
   - `role = agent`
3. Exchange the launch token with `POST /api/v1/mcp/converse/session`.
4. Configure the standalone MCP client with the returned session or configure it to perform exchange.
5. Call MCP tool `ask_agent` with `{"message":"Introduce yourself using your configured persona."}`.
6. Call `ask_agent` again with a follow-up that depends on prior context.
7. Verify:
   - answer uses the configured agent turn loop, not standalone retrieval defaults;
   - second answer preserves conversation history;
   - source channel is recorded as `mcp`;
   - no `agentId` tool parameter is accepted.

## US1 Security Regression Checks

1. Present a workspace API token to the converse endpoint and verify rejection.
2. Present an embed/public-link launch token to exchange and verify rejection.
3. Attempt legacy document-management MCP tools on the public converse path and verify denial.
4. Rotate/revoke/disable the grant, then call `ask_agent` with the existing session and verify the next request fails.
5. Repeat exchange with the old token and verify it fails.

## US2: Agent-Aware Grounded Answer and Resources

1. Configure `Claudio` with non-default retrieval settings: narrowed source scope, rerank enabled, citations enabled.
2. Ask the same grounded question through in-product chat and through MCP `answer_grounded`.
3. Verify retrieved evidence and citation behavior match the agent's configured behavior.
4. Disable citation display for the agent and verify MCP grounded answer omits citations.
5. List MCP resources and read one resource.
6. Verify:
   - only agent-visible documents appear;
   - content is sanitized for the public surface;
   - internal document/chunk ids and hidden metadata are not leaked.

## US4: OAuth Front Door

1. Fetch MCP protected-resource metadata.
2. Register a dynamic client if the connector requires it.
3. Complete PKCE authorization.
4. Exchange the authorization code for a session.
5. Call `ask_agent` and verify it has the same authority as the launch-token session.
6. Refresh the session and verify continued access.
7. Revoke/rotate the grant and verify refresh and subsequent requests fail.

## Blocked US3 Check

Do not implement app-on-behalf signed end-user identity until spec 097 / PR #783 has merged to `main`. After it merges, rerun planning for the US3 slice and verify two signed end-user identities under one credential receive isolated conversations.

## Documentation Verification

Before shipping implementation, verify updated docs cover:

- grant issuance and secret handling;
- launch-token exchange;
- MCP client configuration;
- OAuth connector setup;
- read-only resources and grounded answer behavior;
- explicit warning that workspace API tokens and embed/public-link tokens are rejected on the public converse path.
