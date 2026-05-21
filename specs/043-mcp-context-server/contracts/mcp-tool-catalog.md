# MCP Tool Catalog

This feature adds a standalone remote MCP server package. The package consumes existing Radioso HTTP endpoints through a focused package-local client adapter and does not introduce a new backend MCP transport inside the Radioso app.

> **Amendment 2026-05-19**: Server-side approval-token verification has been removed. Authorization is the workspace API token plus the granted MCP session capabilities; the underlying workspace permission is enforced at the upstream Radioso REST API. Tools marked "approval required" now mean `requiresApproval: true` is advertised so the MCP host (Cursor, Claude Desktop, ChatGPT) prompts the user; the server does not block execution waiting for a separate token.

## Capability Discovery Rules

- Tool discovery is session-aware: callers only see tools granted by exchange-time capability policy.
- Read and write tools are both described through MCP `tools/list`.
- Write tools advertise `requiresApproval: true` so MCP hosts can prompt the user before execution.

## Read tools

- `describe_capabilities`
  - Returns the granted read and write operations for the current MCP access session.

- `list_documents`
  - Lists workspace documents with supported pagination inputs.

- `get_document`
  - Returns one workspace document by ID.

- `search_documents`
  - Runs Radioso document search for the authenticated workspace.

- `answer_grounded`
  - Produces a grounded answer through the existing chat path and returns citations plus optional retrieval details.

- `get_retrieval_settings`
  - Returns the workspace retrieval settings when the upstream deployment exposes that capability.

## Write tools

- `create_document`
  - Creates a workspace document from title, content, metadata, and optional external document ID.
  - Advertised with `requiresApproval: true` for host-side prompting.

- `update_document`
  - Updates an existing workspace document.
  - Advertised with `requiresApproval: true` for host-side prompting.

- `delete_document`
  - Deletes an existing workspace document.
  - Advertised with `requiresApproval: true` for host-side prompting.

- `reprocess_document`
  - Queues a workspace document for reprocessing.
  - Advertised with `requiresApproval: true` for host-side prompting.

- `update_retrieval_settings`
  - Applies a validated partial patch by reading current retrieval settings, merging allowed fields, and submitting the merged update through the existing settings API.
  - Advertised with `requiresApproval: true` for host-side prompting.

## Notes

- Workspace scope is determined by the upstream Radioso workspace API token captured during auth exchange.
- MCP clients never receive the raw upstream Radioso token.
- The MCP package must not access the database directly.
- If a required backend capability is missing, the tool must fail with a structured unsupported-capability error.
- Tool execution is checked against capability policy and the workspace permission required by the upstream Radioso route. The package no longer enforces a secondary approval token.
