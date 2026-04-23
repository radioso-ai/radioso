# MCP Tool Catalog

This feature adds a standalone remote MCP server package. The package consumes existing Radioso HTTP endpoints through a focused package-local client adapter and does not introduce a new backend MCP transport inside the Radioso app.

## Capability Discovery Rules

- Tool discovery is session-aware: callers only see tools granted by exchange-time capability policy.
- Read and write tools are both described through MCP `tools/list`.
- Governed write tools declare that an approval grant is required in their package-local metadata and operator docs.

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
  - Approval required in the remote hosted flow.

- `update_document`
  - Updates an existing workspace document.
  - Approval required in the remote hosted flow.

- `delete_document`
  - Deletes an existing workspace document.
  - Approval required in the remote hosted flow.

- `reprocess_document`
  - Queues a workspace document for reprocessing.
  - Approval required in the remote hosted flow.

- `update_retrieval_settings`
  - Applies a validated partial patch by reading current retrieval settings, merging allowed fields, and submitting the merged update through the existing settings API.
  - Approval required in the remote hosted flow.

## Notes

- Workspace scope is determined by the upstream Radioso workspace API token captured during auth exchange.
- MCP clients never receive the raw upstream Radioso token.
- The MCP package must not access the database directly.
- If a required backend capability is missing, the tool must fail with a structured unsupported-capability error.
- Tool execution must be checked against both capability policy and approval state before calling upstream Radioso APIs.
