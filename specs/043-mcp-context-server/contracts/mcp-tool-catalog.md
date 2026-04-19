# MCP Tool Catalog

This feature adds a standalone MCP server package. It does not introduce a new backend HTTP transport in v1. The MCP package consumes existing Radioso HTTP endpoints through the first-party client boundary.

## Read tools

- `describe_capabilities`
  - Returns the supported read and write operations for the running MCP package.

- `list_documents`
  - Lists workspace documents with supported pagination inputs.

- `get_document`
  - Returns one workspace document by ID.

- `search_documents`
  - Runs Radioso document search for the authenticated workspace.

- `answer_grounded`
  - Produces a grounded answer through the existing chat path and returns citations plus optional retrieval details.

- `get_retrieval_settings`
  - Returns the workspace retrieval settings.

## Write tools

- `create_document`
  - Creates a workspace document from title, content, metadata, and optional external document ID.

- `update_document`
  - Updates an existing workspace document.

- `delete_document`
  - Deletes an existing workspace document.

- `reprocess_document`
  - Queues a workspace document for reprocessing.

- `update_retrieval_settings`
  - Applies a validated partial patch by reading current retrieval settings, merging allowed fields, and submitting the merged update through the existing settings API.

## Notes

- Workspace scope is determined entirely by the Radioso API token used to start the package.
- The MCP package must not access the database directly.
- If a required backend capability is missing, the tool must fail with a structured unsupported-capability error.
