# Contract: Standalone-To-Backend Operator Capability

These Operator Copilot-owned routes are internal product boundaries, not
alternate public operator APIs. Every call requires the configured standalone
service identity and a signed request. They are omitted from ordinary end-user
SDK convenience APIs and from the public REST OpenAPI document.

## Validate and mint proof

- `POST /api/v1/internal/operator-copilot/mcp/admissions`
- Input: raw access token, invocation UUID, MCP method, optional descriptor
  name, exact resource, timestamp, nonce, and body digest.
- Auth: HMAC service signature covering method, path, timestamp, nonce, and body
  digest.
- Output: single-use short-lived principal proof and authorized method metadata.
  The proof binds an authoritative credential/admission ID, exact issued tool
  scope ceiling, issued offline flag, client version, immutable client metadata
  snapshot ID, external credential epoch, grant/version, principal/workspace,
  method/descriptor/resource/body, expiry, and nonce. Grant/client/epoch versions
  use canonical decimal strings. The raw access token is never echoed.

The authorization service validates access-token digest, its exact issued scope
ceiling, expiry, client version/status, metadata snapshot, grant/resource,
continuous membership tenure, deployment credential epoch, and grant version.
Operator Copilot then validates method, requested descriptor disposition/scope,
and current descriptor permissions before issuing a proof. Catalog and invoke
re-read the persisted credential/admission state by ID and cross-check every
signed ceiling/version/epoch field; they never reconstruct authority from the
broader grant alone.

## Catalog

- `POST /api/v1/internal/operator-copilot/mcp/catalog`
- Input: admission proof.
- Atomically consumes the proof, repeats authoritative grant/tenure/role checks,
and returns only currently eligible/authorized descriptor contracts. It returns
no cache hint; the next catalog request repeats the entire current-state check.

## Invoke

- `POST /api/v1/internal/operator-copilot/mcp/invocations`
- Input: admission proof, descriptor, arguments, and optional operation identity.
- Atomically consumes the proof, validates the Zod descriptor input, derives the
  verification cost, reserves budget, and invokes through Operator Copilot's
  MCP boundary with current-authorization checkpoints.
- Output: bounded structured result and safe reconciliation metadata.

Wrong service, signature, resource, method, descriptor, expiry, nonce replay,
proof replay, grant version, workspace, or direct unsigned caller fails closed.
The internal proof is never forwarded to an owning module or external provider.
