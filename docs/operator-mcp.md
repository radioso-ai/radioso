---
title: "Operator MCP OAuth Access"
description: "Connect an OAuth-capable MCP client to Ray's governed workspace tools and manage its access."
last_updated: 2026-09-26
---

# Operator MCP OAuth Access

Operator MCP lets a signed-in workspace member inspect and author an agent from a compatible remote MCP client. You choose the workspace and scopes in Radioso before the client receives a credential. Each tool call rechecks the user, membership, grant, client, and current workspace permission.

This is separate from an agent's **Channels → MCP** connection. The agent connection exposes `ask_agent` for one configured agent. Operator MCP exposes a small set of Ray tools for the person who completed OAuth consent.

Operator MCP always identifies a person. Its `/operator/mcp` resource requires browser consent and a grant tied to a workspace member, so the credential-free connection an operator can open on an agent (see [MCP Client Setup](./mcp-client-setup.md)) reaches `ask_agent` on that one agent and never reaches this surface. An agent's public id authorizes a conversation; it authorizes no read, probe, or proposal here.

## Connect from the dashboard

1. Open **Settings → API access** and find **Operator MCP**.
2. Choose the **Codex**, **Claude**, **Cursor**, or **Other** tab and copy the setup it shows. The command or configuration includes the canonical Operator MCP URL for this deployment.
3. Paste it into the client and complete the browser sign-in when it asks.
4. Choose the workspace and requested scopes, then approve the connection. If the client requests refresh access, it stays connected until that access expires or you revoke the grant.
5. Return to **Settings → API access** to inspect or revoke the grant. Revocation invalidates its access and refresh lineage on the next request.

The setup snippets are labelled **Not verified** until Radioso has captured a full compatibility transcript for that client build. They contain no credential; a successful connection still requires the client's OAuth flow to complete.

## Tool boundary

The catalog is rebuilt from the caller's current permissions for every list or call, and every production Ray descriptor carries a reviewed disposition: eligible with a scope and retry contract, or excluded with a stated reason. Each listed tool advertises both its arguments and its result as an object schema in JSON Schema 2020-12, so a client that validates `tools/list` against the metaschema loads the whole catalog. It currently admits:

- **Reads** (`operator:read`) — the workspace, agent, and routine readers (`workspace_settings`, `agent_configuration`, `agent_skills`, `context_variables`, `routine_definition`, `validate_routine`), the history and document readers (`conversation_history_search`, `conversation_transcript`, `document_search`, `document_status`, `list_documents`, `document_chunks`), the quality, eval, trace, and triage readers (`quality_signals`, `eval_results`, `turn_trace`, `workspace_triage`), the Test Chat readers (`test_chat_sessions`, `test_chat_transcript`, `test_chat_turn_trace`), plus `retrieval_settings`, `agent_publication_state`, `agent_publication_candidate`, `agent_publication_candidate_change`, and `proposal_detail`. Enterprise workspaces also list `workspace_usage_limits`, which shows the organization plan and usage windows. `proposal_detail` reads the same safe proposal preview the dashboard shows, including its draft, status, timestamps, failure reason, and pending review link. Its result says when a proposal is a reviewed operation; use `reviewed_proposal_outcome` for that operation. Retrieval settings show code-owned system defaults as read-only and identify the writable per-agent setting. The conversation readers cover customer and dashboard chat; a Test Chat session is a private test run pinned to one revision per side, and only the Test Chat readers see it. `list_documents` returns a cursor-paginated, content-free inventory. It accepts a source id, processing status, exact external document ids or metadata, case-insensitive title text, and retrieval eligibility. Each response contains at most 25 rows; repeat `nextCursor` to continue. Each row includes the document and source identities, status, metadata, content length, and timestamps, so an operator can verify an import without reading its body. `workspace_usage_limits` returns the Enterprise organization plan plus used, limit, remaining, and reset information for answer, document, and indexing windows.
- **Probes** (`operator:probe`) — `retrieval_probe` and `send_test_chat_message`. `retrieval_probe` runs one retrieval-only search with an agent's own settings. `send_test_chat_message` sends one message through the agent's Test Chat and returns the answer and the stages the turn went through. Without `testExecutionId` it starts a session the way the dashboard's Test Chat does: on `revisionId` when you name one, otherwise on a fresh candidate of the saved draft, or on the published revision when the draft has no changes. With `testExecutionId` it continues that session. Sessions started here always run with skill effects suppressed and appear in the dashboard's Test Chat history. A comparison, or a session started with skill effects allowed, continues only in the dashboard. Each call runs one agent turn, so a retry without an operation id runs a second one. A retry that repeats the first call's operation id reports that call's outcome without running another turn; read the turn itself with `test_chat_transcript`.
- **Proposals** (`operator:propose`) — the agent, directive, routine, context-variable, skill, and ingestion-settings proposal tools (`propose_agent_setting`, `propose_directive`, `propose_directive_enablement`, `propose_directive_removal`, `propose_routine`, `propose_routine_edit`, `propose_routine_exposure`, `propose_context_variable`, `propose_skill_config`, `propose_ingestion_settings`, `propose_greeting`, `propose_document`, and `propose_document_retrieval`), plus `prepare_routine_structure`, `prepare_retrieval_settings`, `prepare_agent_publication`, `prepare_document_import`, `prepare_document_removal`, and `prepare_document_reprocess`. `prepare_document_import` accepts at most 100 documents and 20,000 characters per body; its complete JSON input is limited to 2,000,000 UTF-8 bytes. Every imported document names an `externalDocumentId`; the same source and id replace changed content and leave matching hashes unchanged. It checks stored-document headroom before writing and reports the limit, current count, and requested new count when the batch will not fit. `prepare_document_removal` shows the exact CAS-fenced documents it will delete and names unknown ids. `prepare_document_reprocess` accepts one tagged selector: `documents` with bounded ids, `source` with a source id, or `all` with `all: true`; it shows eligible and skipped counts before queueing. `propose_document` drafts a new workspace knowledge document; `propose_document_retrieval` changes an existing document's retrieval eligibility, its auto-exclude expiry, and the metadata retrieval filters and boosts on. `propose_routine_exposure` offers a routine to calling AI agents as a named tool, or withdraws that offer; a tool name is fixed once the agent is published with it, and the revision gate refuses a rename, so a call that omits `toolName` keeps the routine's current name. `prepare_routine_structure` takes a `kind` of `edit`, `create`, or `delete`: `edit` applies explicit graph commands to an existing routine, `create` drafts a whole new one, and `delete` retires one. A routine preparation returns a bounded before/after review of its explicit step, slot, terminal, and edge edits; its full detail remains available through the reviewed outcome. Retrieval preparation changes the existing per-agent retrieval skill; probe overrides remain diagnostic-only. Publication preparation creates an immutable candidate and returns its identity, fences, and validation result. Read `agent_publication_candidate` page by page, then use `agent_publication_candidate_change` for any truncated value before asking for confirmation. An operation id is optional. Send one as `params.operationId`, beside `name` and `arguments`, and a retried call returns the original result, reconciled from the proposal the first call created. A retry without one can leave a second pending proposal for review. Proposal fences compare the fields the proposal changes. An unrelated settings update does not make a proposal stale. When a guarded field changed, the stale result names it; when the target is gone, it reports `Target deleted`. `propose_directive` accepts `name`, `condition`, `action`, `priority`, and `excludes` when a directive needs exact authored behavior. Supplied text is kept verbatim. A new directive can omit `intent` when it supplies `name`, `condition`, and `action`; otherwise `intent` lets the coach fill only the missing fields. On an edit, supplied fields replace only those fields. `priority` is an integer from 0 through 100. Each `excludes` entry names an existing built-in or authored directive for that agent, such as `represent-organization`; the tool refuses an unknown name and lists valid names. Proposal cards show a non-default priority and the directives they replace.
- **Reviewed execution** (`operator:write`) — `execute_reviewed_proposal`, `reviewed_proposal_outcome`, and `cancel_reviewed_proposal`. These three tools address only an operation a `prepare_*` tool created, and each checks the caller's current permission for that operation's target before returning a result. A person approves or dismisses a `propose_*` proposal in the dashboard; pass that proposal id to `proposal_detail`, not to a reviewed-operation tool. First read the prepared result and show its digest, target, expected version, expiry, and draft/live effect in the conversation. Call execution only after the person confirms that exact result. The outcome reader reconciles a lost response; cancellation is available only while the same bound reviewed operation is pending and has not started execution. Without an operation id, an identical execution retried on the same connection reconciles with its first attempt; a call that sent an id retries with that same id. Cancelling an operation that is already dismissed returns dismissed. An execution whose outcome the owner could not confirm answers `uncertain` on retry until its apply claim lapses after about five minutes; a retry after that reconciles it. An execution the owner refuses before changing anything — a publication candidate that no longer validates, say — settles as `failed` with the owner's reason, and the operator prepares the change again.
- **Acts** (`operator:act`) — `set_triage_state`, admitted because it is fenced by an expected version rather than appended: a lost-response retry either lands the transition once or comes back a conflict against whatever won, never a duplicate effect.

Recrawling, eval-suite runs, customer replies, credential administration, and provider authorization stay outside this catalog — each either depends on dashboard/Ray-conversation context or has a distinct owner contract.

## Investigate a Test Chat turn

When a routine or directive behaves differently in Test Chat than you expect, start from the session the operator ran. `test_chat_sessions` lists the agent's recent sessions with the revision each one ran and its first message, which is usually enough to find the right one and to see whether it ran the draft candidate or a published version. `test_chat_transcript` shows each turn's answer, failure code, and the stages it passed through, such as a routine activation that was skipped. `test_chat_turn_trace` returns that turn's full diagnostic spine, with each stage's inputs and outputs. To check a fix, send the same message with `send_test_chat_message`, either continuing the session or starting a new one on the revision you want to compare.

## Conversational confirmation

The MCP client is responsible for asking the person to confirm a reviewed operation. Radioso binds execution to the prepared proposal, grant, client, workspace, principal, digest, expiry, and version fence, but it cannot independently prove that a person saw or approved the conversation. Grant `operator:write` only to clients you trust to honor that confirmation step.

Routine edits and publication are separate operations. Applying a routine or retrieval proposal changes the relevant draft according to its existing lifecycle; publishing requires a separately prepared candidate and confirmation. A changed draft, target, or expired review needs a fresh preparation.

Only reviewed MCP proposals created by this flow can use the reviewed execution, outcome, or cancellation tools. Existing dashboard and conversation proposals remain on their original surfaces.

## OAuth profile

Operator MCP uses an authorization-code flow with S256 PKCE, an exact RFC 8707 resource value, RFC 9207 issuer binding on authorization responses, immutable client metadata snapshots, and public clients. Access credentials last at most 15 minutes. When a client requests refresh access, approving the connection includes it; refresh access can only narrow the approved tool scopes. The resource supports Radioso's stateless `2026-07-28` profile and a standard `2025-06-18` initialize/list/call compatibility path; both use the same authorization, catalog, rate-limit, proof, and audit boundaries.

The standalone protected resource is:

```text
https://mcp.example.com/operator/mcp
```

Its metadata is published at:

```text
https://mcp.example.com/.well-known/oauth-protected-resource/operator/mcp
```

Authorization-server metadata comes from the configured Radioso issuer at `/.well-known/oauth-authorization-server`. The resource URL is byte-for-byte significant; a trailing slash is a different audience and is rejected.

## Deployment

For Terraform-managed Cloud Run, turn on the existing standalone MCP service. Its `/mcp` and `/operator/mcp` routes stay separate, but the same service deployment supplies both.

```hcl
radioso_mcp_enabled = true
```

The GitHub Terraform workflow discovers the Cloud Run MCP URL and uses it for both MCP routes. Set `MCP_PUBLIC_ORIGIN` only when the MCP service is served from a custom domain. Terraform generates one `OPERATOR_MCP_INTERNAL_SECRET`, injects the exact same bytes into the backend and standalone service, and exports `operator_mcp_resource_url`. It also sends that URL to the dashboard as `RADIOSO_OPERATOR_MCP_PUBLIC_URL`.

The Cloud Run URL exists after the standalone MCP service has been created. When bootstrapping a deployment, run Terraform once to create the service, then run it again; the workflow discovers the new URL and configures Operator MCP automatically. A direct Terraform run needs `mcp_public_origin` set to the Cloud Run URL or custom domain after the service exists.

For a manual deployment, configure both processes with the same values:

```dotenv
OPERATOR_MCP_RESOURCE_URL=https://mcp.example.com/operator/mcp
OPERATOR_MCP_ISSUER_URL=https://app.example.com
OPERATOR_MCP_INTERNAL_SECRET=<at least 32 random characters>
OPERATOR_MCP_CREDENTIAL_EPOCH=1
```

Production resource and issuer URLs must use HTTPS. Local development may use HTTP only on a loopback host.

## Rotate or restore credentials

`OPERATOR_MCP_CREDENTIAL_EPOCH` is an external monotonic generation, not data recovered from a database backup. All enabled backend replicas and the standalone service must use the same epoch and internal-secret fingerprint.

Operator MCP starts when its resource URL, issuer URL, internal secret, and credential epoch are all configured in both processes. It is available to every workspace; there is no deployment allowlist. The verification budget stays capped at six operations per credential each minute.

Deployment availability does not grant a client access. Each connection still needs browser OAuth consent, an active membership in the selected workspace, approved scopes, and the canonical resource URL. Every tool request rechecks the grant, client, membership, scopes, and current permissions; it remains subject to source and principal rate limits and is recorded in audit logs.

To rotate the internal secret or restore an older database:

1. Choose an epoch greater than every epoch used by the deployment.
2. With `DATABASE_URL`, `OPERATOR_MCP_RESOURCE_URL`, the new `OPERATOR_MCP_INTERNAL_SECRET`, and the new `OPERATOR_MCP_CREDENTIAL_EPOCH` loaded, set `OPERATOR_MCP_PREVIOUS_CREDENTIAL_EPOCH` to the current persisted epoch and run `pnpm --dir backend run operator-mcp:rotate-credential-state` once.
3. Deploy every enabled replica with the same new secret and epoch.
4. Check readiness before routing traffic.

Startup never advances a persisted epoch. A replica with an older epoch, a newer unpersisted epoch, or a different fingerprint at the same epoch stays unready. This makes an old database plus an old key insufficient to revive credentials after a restore.

## Failure recovery

- **Client rejects the setup:** confirm that it supports remote HTTP MCP with OAuth, remove the server from the client, and add it again from the dashboard.
- **Audience mismatch:** copy the canonical URL from **Settings → API access** without adding a slash, query, or fragment.
- **Consent expired or account changed:** restart the connection from the client so Radioso creates a new browser-bound transaction.
- **Permission or membership changed:** restore the required workspace access, then reconnect if the grant was revoked.
- **Credential epoch mismatch:** complete the explicit rotation step and deploy the same epoch and secret to every replica.
- **Rejected request:** a malformed envelope answers `-32600 Invalid Request` and lists what was wrong in the JSON-RPC `error.data`, one `<path>: <reason>` line each, such as `params._meta.io.modelcontextprotocol/clientCapabilities: invalid_type` when a self-describing request leaves out the client capabilities. Send `{}` there if the client declares none.
- **Rejected arguments:** a refused call answers `-32602 invalid_arguments` and carries what was wrong in the JSON-RPC `error.data`. A schema rejection names fields and array positions, never the values at them. A routine or publication validation refusal carries bounded diagnostic objects with the routine id, name when available, code, location, and message, so correct the routine with `validate_routine` or `prepare_routine_structure`. A `propose_*` proposal id passed to `reviewed_proposal_outcome` or `cancel_reviewed_proposal` identifies the dashboard review and directs the client to `proposal_detail` only for a caller holding that proposal's target read permission — the same permission `proposal_detail` itself requires; without it, and for an unknown id, the call gets the same not-found refusal.
- **Client reports an unavailable runtime:** search the backend logs for `operator_mcp_route_failed`, which names the cause and carries the invocation id the audit record is keyed by. `operator_mcp_route_not_ready` instead means the replica has not reached credential readiness.

## Read next

- [MCP client setup](./mcp-client-setup.md) for the separate one-agent `ask_agent` connection.
- [MCP server package](../packages/radioso-mcp-server/README.md) for runtime configuration and checks.
