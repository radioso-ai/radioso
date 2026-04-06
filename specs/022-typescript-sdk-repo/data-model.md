# Data Model: Radioso TypeScript SDK

## SDK Release Surface

- **Description**: The externally documented SDK product boundary for a given release.
- **Includes**:
  - supported operations
  - supported authentication mode
  - package version
  - aligned backend contract snapshot
  - examples and quickstart flows
- **Rules**:
  - must clearly distinguish included versus excluded endpoint categories
  - must remain aligned with a specific backend contract snapshot

## Contract Snapshot

- **Description**: The versioned backend API description copied from the code-first backend artifacts into the SDK package for generation and review.
- **Includes**:
  - OpenAPI JSON artifact
  - OpenAPI YAML artifact
  - source backend contract reference
- **Rules**:
  - generated from backend code-first artifacts only
  - never hand-authored inside the SDK package

## Client Configuration

- **Description**: Consumer-provided values used to connect the SDK to a Radioso deployment.
- **Fields**:
  - `baseUrl`
  - `apiToken`
  - optional request defaults such as headers or timeout behavior
- **Rules**:
  - token-based configuration is required for v1
  - configuration must not require source edits

## Supported Operation

- **Description**: A documented Radioso API action intentionally exposed through the v1 SDK.
- **Fields**:
  - operation identifier
  - request shape
  - response shape
  - auth expectation
  - error expectation
- **Rules**:
  - must be present in the backend contract
  - must be explicitly accepted into the v1 support boundary
  - browser-session-only and admin-only flows remain excluded from v1

## SDK Error

- **Description**: The normalized failure surface returned by SDK operations when transport, auth, validation, or server failures occur.
- **Fields**:
  - machine-readable error code
  - human-readable message
  - HTTP status when available
  - backend error payload when available
- **Rules**:
  - must preserve actionable backend error context when present
  - must normalize non-JSON and interrupted-stream failures into a consistent SDK shape

## Streaming Chat Event

- **Description**: A typed event emitted by the SDK during streaming chat consumption.
- **Variants**:
  - stream started
  - incremental content
  - completion
  - failure
- **Rules**:
  - events must preserve backend ordering
  - failure must be explicit and must not masquerade as completion
