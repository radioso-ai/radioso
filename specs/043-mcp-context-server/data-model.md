# Data Model: MCP Context Server

## MCP Server Config

- **baseUrl**: Radioso server origin used for all HTTP calls.
- **apiToken**: Workspace-scoped Radioso API token used for read and write tools.
- **serverName**: Optional visible name for the MCP server instance.
- **logLevel**: Optional runtime logging verbosity.

**Validation rules**
- `baseUrl` must be a valid absolute HTTP or HTTPS URL.
- `apiToken` must be non-empty and must never be written to repo-tracked files.

## MCP Tool Capability

- **name**: Stable MCP tool identifier.
- **accessMode**: `read` or `write`.
- **description**: Plain-language contract for the tool.
- **inputSchema**: Validated request shape.
- **handler**: Package-local executor that translates the request to Radioso operations.

**Relationships**
- Each tool capability is executed through the Radioso API adapter.
- Capabilities are grouped into read-path and write-path catalogs for discovery and review.

## Radioso API Adapter

- **client**: Underlying HTTP or SDK-backed Radioso client.
- **workspaceScope**: Implicitly bound by the API token used at startup.
- **operations**: Read and write methods mapped to the supported MCP tool catalog.

**Validation rules**
- Adapter methods must preserve workspace scoping.
- Adapter methods must not bypass backend validation or authorization.

## MCP Tool Result

- **summary**: Short human-readable status text.
- **data**: Structured payload returned from Radioso.
- **warnings**: Optional non-fatal notes, such as unsupported capability or partial visibility.

**State transitions**
- Request received
- Input validated
- Radioso operation executed
- Structured success or structured failure returned
