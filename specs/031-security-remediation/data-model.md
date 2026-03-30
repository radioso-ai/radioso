# Data Model: Security Remediation

## Overview

This feature adds one new durable enforcement model and redefines how existing auth-related records are interpreted during admin requests. It also introduces explicit handling states for legacy connector secret records.

## Entities

### 1. Workspace Access Context

- **Purpose**: Represents the active workspace for an authenticated administrator without relying on a browser-held reusable bearer token.
- **Source of truth**:
  - Existing account session cookie for identity
  - Existing workspace ownership records for authorization
  - Client-provided non-sensitive active workspace identifier for selection
- **Key fields**:
  - `accountId`
  - `workspaceId`
  - `selectionSource` (`request`, `session-default`, or equivalent)
  - `resolvedAt`
- **Validation rules**:
  - The workspace must belong to the authenticated account.
  - Missing or unauthorized workspace selection fails before business logic runs.
- **State transitions**:
  - `unresolved -> resolved`
  - `resolved -> rejected` when the workspace is removed or no longer belongs to the account

### 2. Connector Secret Safety State

- **Purpose**: Captures whether a connector configuration containing secrets is safely encrypted, legacy plaintext, or invalid for use.
- **Source of truth**:
  - Existing `connector_configs` row
  - Connector encryption key presence/validity
  - Secret field decryptability
- **Derived states**:
  - `encrypted-valid`
  - `legacy-plaintext-detected`
  - `ciphertext-invalid`
  - `write-blocked-no-key`
- **Validation rules**:
  - New or updated secret fields require valid encryption configuration.
  - Legacy plaintext or invalid ciphertext cannot be silently treated as trusted secret storage.
- **Operator actions**:
  - Re-enter secret value
  - Rotate secret externally and save new value
  - Disable connector until corrected

### 3. Abuse Control Counter

- **Purpose**: Durable tracking record for rate-limited security-sensitive actions.
- **Storage**: New PostgreSQL table for keyed abuse-control windows
- **Key fields**:
  - `scope` (login, registration, admin-workspace-access, upload, anonymous-chat, etc.)
  - `subjectKey` (derived actor identifier such as account, IP, workspace/session pair, or composite key)
  - `windowStartedAt`
  - `attemptCount`
  - `blockedUntil`
  - `updatedAt`
- **Validation rules**:
  - Counters are keyed consistently for each policy scope.
  - Enforcement must survive process restarts and work across multiple instances.
  - Expired windows must be safely cleaned up or ignored.
- **State transitions**:
  - `active`
  - `blocked`
  - `expired`

### 4. Legacy Security State

- **Purpose**: Represents pre-remediation browser sessions or stored connector data that need explicit rollout behavior.
- **Examples**:
  - Browser storage containing workspace bearer tokens from old builds
  - Connector secret records stored before fail-closed encryption
- **Handling rules**:
  - Legacy browser credentials are ignored or cleared during bootstrap.
  - Legacy connector secret rows are surfaced as remediation-required state rather than auto-trusted.

## Relationships

- A **Workspace Access Context** belongs to one authenticated account and one owned workspace.
- A **Connector Secret Safety State** is derived from one connector configuration record.
- An **Abuse Control Counter** applies to one policy scope and one subject key, but many HTTP requests can map to the same counter.
- **Legacy Security State** may exist alongside current sessions and connector records until the operator or user completes the remediation path.

## Persistence Changes

### New table

- **Abuse control table**
  - Stores durable counters/block windows for security-sensitive endpoints
  - Indexed by `(scope, subjectKey)` and expiry-relevant time columns

### Existing tables reused

- `sessions`
- `workspaces`
- `workspace_tokens` (legacy compatibility only; expected to shrink in importance after remediation)
- `connector_configs`
- `audit_events`

## Auditability Notes

- Blocked writes for connector secrets and enforced abuse-control events must produce auditable records.
- Migration and rollout behavior for legacy connector-secret state should be observable without direct database inspection.
