# Contract Notes: Extension Boundaries

This feature is not expected to add public HTTP endpoints. These notes define internal extension contracts that planning and implementation must preserve.

## Application Composition Contract

The application has one default composition path for local and self-hosted behavior. Optional modules are registered by passing them into composition, not by importing them from route handlers or product services.

Required behavior:

- Registers default modules deterministically.
- Rejects duplicate module identifiers.
- Allows tests to inject representative optional modules.
- Reports initialization failures through existing logging and incident paths where available.
- Preserves shutdown hooks for registered modules.

## Capability Policy Contract

Product workflows can ask whether a named action is available for the current context.

Required behavior:

- Default policy allows all existing actions.
- Strict test policy can deny a representative action.
- Unknown capability names are rejected or reported as programming errors.
- Denials occur before mutations or privileged operations.
- Denial response text is operational API/UI copy, not assistant conversational output.

## Extension Category Contracts

Each extension category must name its owner, default behavior, registration path, and anti-goals.

Minimum categories:

- Connectors
- Telemetry, analytics, and incident sinks
- Retrieval strategy or stage construction
- Document storage
- Worker dispatch
- Auth or session policy
- Capability policy

## OpenAPI Ownership

No public HTTP contract change is planned. If implementation requires a new capability-denial response shape on an existing route, the runtime contract must be defined in `backend/src/app/http/openapi/document.ts`, and `backend/openapi.yaml` plus `backend/openapi.json` must be regenerated. Those generated files must not be hand-edited.
