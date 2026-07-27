# Public HTTP Compatibility Contract

No new embedding profile, validation, transition, rollback, rebuild, dimension, or
vector-backend endpoint is added.

Existing ingestion-settings reads and writes:

- retain the current request/response shapes;
- retain exactly the current four-model enum;
- retain existing settings-read and LLM-model-management permissions;
- retain active model, pending model, failure and cancellation presentation;
- never expose internal profile/space IDs, endpoint fingerprints, credentials,
  provider payloads or vector-backend controls.

Changing to another supported model starts internal validation/transition. Reading
settings never causes promotion. Echoing the workspace's current legacy model while
updating unrelated settings is an unchanged selection; a different unsupported value
is rejected.

The checked-in OpenAPI and TypeScript SDK are regenerated/verified only to prove
compatibility. MCP receives no new model/profile/backend operation.

