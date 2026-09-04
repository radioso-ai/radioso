# Data Model: Operator MCP With Delegated OAuth

## Operator MCP Client

Validated identity for one OAuth client.

- `id`: UUID primary key.
- `clientId`: bounded identifier; HTTPS metadata-document URL or preregistered ID.
- `registrationMethod`: `metadata_document | preregistered | dynamic`.
- `applicationType`: `web | native`.
- `displayName`: bounded, safe text.
- `clientUri`: validated public HTTPS URI or null.
- `redirectUris`: non-empty bounded array of exact validated URIs.
- `tokenEndpointAuthMethod`: initially `none` for public clients.
- `metadataDigest`: versioned digest of the normalized validated fields.
- `version`: monotonic identity revision.
- `status`: `active | revoked | expired` plus safe revocation metadata.
- `expiresAt`: required for dynamic registrations; otherwise null.
- `createdAt`, `updatedAt`.

Validation: URLs and redirects satisfy the spec profile. Arbitrary remote
metadata is never stored; only normalized allowlisted fields survive.

## Client Metadata Snapshot

Immutable normalized identity used by one authorization lineage.

- `id`, `clientId`, `clientVersion`, `metadataDigest`.
- bounded allowlisted display/client/redirect/application/token-auth fields.
- `source`: metadata document, preregistration, or bounded compatibility record.
- `validatedAt`, `expiresAt`.

The authorization transaction, code, grant, access row, and refresh lineage
bind the same snapshot ID and digest. A later remote metadata fetch creates a
new snapshot and cannot change an in-flight authorization.

## Authorization Transaction

One short-lived browser consent attempt.

- `id`: unguessable transaction handle.
- `clientId`: operator client foreign key.
- `clientMetadataSnapshotId` and `clientMetadataDigest`: immutable pinned identity.
- `redirectUri`: exact redirect selected from the pinned client metadata.
- `state`: client value returned unchanged but never logged.
- `codeChallenge`: S256 challenge; verifier is never stored.
- `resource`: exact canonical operator resource.
- `requestedToolScopes`: non-empty subset of four fixed scopes.
- `requestedOfflineAccess`: boolean.
- `accountId`, `userId`, `sessionId`: nullable until bound; immutable afterward.
- `workspaceId`, `membershipId`: nullable until approval.
- `approvedToolScopes`, `approvedOfflineAccess`: nullable until decision.
- `status`: `pending | approved | denied | consumed | expired`.
- `authorizationCodeDigest`: present only after approval.
- `expiresAt`, `createdAt`, `decidedAt`, `consumedAt`.

Transitions: `pending -> approved|denied|expired`; `approved -> consumed|expired`.
Approval is single-writer and bound to the current browser session/account/user.

## Operator MCP Grant

Revocable human delegation for one client, workspace, and access tenure.

- `id`: UUID.
- `clientId`, `clientVersion`, `clientMetadataSnapshotId`, `accountId`,
  `workspaceId`, `userId`, `membershipId`.
- `resource`: exact canonical operator audience.
- `toolScopes`: approved fixed scope set.
- `offlineAccess`: boolean.
- `status`: `active | revoked | superseded | expired`.
- `version`: monotonic bigint used in every admission check.
- `credentialEpoch`: deployment security epoch at issuance.
- `createdAt`, `updatedAt`, `lastUsedAt`, `revokedAt`.
- `revokedReason`: fixed safe enum or null.

Invariant: only one active grant per user/client/workspace/resource combination.
A replacement becomes active before the former grant is superseded.

## Access Credential

- `id`, `grantId`.
- `tokenDigest`: unique SHA-256 digest; raw token is returned once.
- `issuedGrantVersion`.
- `issuedClientVersion`, `issuedCredentialEpoch`, `issuedToolScopes`, and
  `issuedOfflineAccess`: immutable credential ceiling; current authority is the
  intersection with the live grant rather than a reason to re-expand it.
- `expiresAt` (maximum 15 minutes), `createdAt`, `lastUsedAt`.

Validation always joins the current grant and live membership; possession does
not bypass revocation or role reduction.

## Refresh Lineage / Refresh Generation

- Lineage: `id`, `grantId`, `clientVersion`, `credentialEpoch`, `status`,
  `currentGeneration`, exact `issuedToolScopes`, `offlineAccess`, `idleExpiresAt`,
  `absoluteExpiresAt`, `revokedAt`, `revokedReason`.
- Generation: `lineageId`, `generation`, unique `tokenDigest`, exact
  `issuedToolScopes`, `consumedAt`, `createdAt`.

Transition: the current generation is atomically consumed and successor
inserted. Any later presentation of a consumed generation atomically revokes
the lineage and grant credential lineage; a successor returned to a winning
concurrent request is therefore unusable.

## Operator MCP Invocation

Safe, transport-neutral receipt for one list or tool request.

- `id`: UUID generated at the standalone edge.
- `grantId`, `grantVersion`, `accountId`, `workspaceId`, `userId`, `clientId`.
- `method`: fixed MCP method.
- `descriptorName`: nullable for catalog list.
- `shape`: nullable fixed descriptor shape.
- `operationId`: required for stateful tool calls.
- `inputDigest`: versioned HMAC digest of canonical validated input; no raw input.
- `verificationCost`, `budgetReservedAt`.
- `proofNonceDigest`, `proofConsumedAt`.
- `status`: `admitted | running | completed | refused | failed`.
- `safeOutcomeCode`, `resultReference`: bounded non-customer-data reference.
- `createdAt`, `completedAt`, `retainedUntil`.

Uniqueness on `(grant_id, operation_id)` coordinates stateful retries. A
different input digest or descriptor under the same operation identity fails.
Rolling budget queries count committed reservations in the prior 60 seconds.

## Deployment Credential State

One row for the operator resource stores the current externally supplied
`credentialEpoch` and a non-reversible fingerprint of the configured internal
credential key. The epoch is monotonic configuration outside the database
backup. Startup never auto-advances it on key change: an empty row may be
initialized, and a strictly higher configured epoch may atomically replace the
stored epoch/fingerprint. A lower configured epoch or a same-epoch fingerprint
mismatch fails readiness. Access/refresh rows issued under another epoch fail.
Restoring an old database and old key under the newer external epoch therefore
invalidates old lineages, while overlapping replicas with mismatched epoch/key
configuration cannot both become ready.

## User Disabled State

`users.disabled_at` is a real nullable account-authentication state. Session and
operator-grant authentication reject a disabled user. Operator grant validation
checks it on every request, so disabling takes effect without waiting for a
grant update. Deletion continues to cascade through the lifecycle transaction.

## Proposal Origin

`CopilotProposal` receives an exact-one origin invariant:

- Conversation origin: non-null `conversationId`, null `operatorMcpInvocationId`.
- Operator MCP origin: null `conversationId`, non-null `operatorMcpInvocationId`.

Messages may attach only conversation-origin proposals. MCP-origin proposals
remain ordinary pending copilot proposals and use the existing optimistic apply
and dismissal behavior.

`copilot_replay_evidence` receives the same exact-one origin invariant and the
MCP invocation foreign key. Evidence cannot name a different origin than its
proposal. Both proposal and evidence invocation foreign keys use
`ON DELETE RESTRICT`; evidence-to-proposal ownership retains its existing
dependent-delete behavior. Cleanup deletes expired evidence first, then only
resolved/expired proposals, then invocations. A pending proposal therefore
retains its invocation, and grant revocation never deletes either record.

## Retention And Cascades

- Transactions/codes expire within five minutes and are purged after a short
  operational window.
- Access-token rows may be purged after expiry plus a bounded audit window.
- Grants and refresh lineages use no longer retention than dashboard Ray
  records. An invocation is retained at least as long as any proposal or replay
  evidence that references it; cleanup follows evidence -> resolved/expired
  proposal -> invocation order.
- Workspace/account/user deletion cascades authorization state and invocation
  receipts. Revoking a grant does not delete an already-created proposal.
