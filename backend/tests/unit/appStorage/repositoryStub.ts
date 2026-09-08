import { vi } from "vitest";

import type { AppStorageRepositoryPort } from "../../../src/modules/appStorage/public.js";

/**
 * A repository that admits everything and stores nothing. Every method answers
 * `admitted`, because admission is the repository's own decision inside the
 * operation's transaction — a service test that wanted to observe a refusal
 * replaces the one method it is about.
 */
export const buildRepositoryStub = (): AppStorageRepositoryPort => ({
  findInstallationState: vi.fn(async () => null),
  setAccessRevoked: vi.fn(async () => ({ admitted: true as const, value: undefined })),
  setRetention: vi.fn(async (input) => ({
    admitted: true as const,
    value: { retainUntil: input.retainUntil, accessRevokedAt: new Date("2026-01-01T00:00:00.000Z") },
  })),
  findRecord: vi.fn(async () => ({ admitted: true as const, value: null })),
  putRecord: vi.fn(async () => ({
    admitted: true as const,
    value: { outcome: "stored" as const, version: 1 },
  })),
  deleteRecord: vi.fn(async () => ({
    admitted: true as const,
    value: { outcome: "deleted" as const },
  })),
  queryByIndex: vi.fn(async () => ({ admitted: true as const, value: [] })),
  readCollectionUsage: vi.fn(async () => ({
    admitted: true as const,
    value: { recordCount: 0, byteSize: 0, reclaimPending: false },
  })),
  listStoredSchemaVersions: vi.fn(async () => ({ admitted: true as const, value: [] })),
  beginIndexRebuild: vi.fn(async () => ({ admitted: true as const, value: { startVersion: 1 } })),
  rebuildIndexBatch: vi.fn(async () => ({
    admitted: true as const,
    value: { rebuiltCount: 0, lastKey: null, incompatibleCount: 0 },
  })),
  finishIndexRebuild: vi.fn(async () => ({ admitted: true as const, value: undefined })),
  claimCollectionsForExpirySweep: vi.fn(async () => []),
  reclaimExpiredRecords: vi.fn(async () => 0),
  listInstallationsDueForRetention: vi.fn(async () => []),
  reclaimRetainedInstallation: vi.fn(async () => ({
    outcome: "reclaimed" as const,
    summary: { recordCount: 0, collectionCount: 0 },
  })),
  openInstallationExport: vi.fn(async () => ({
    admitted: true as const,
    value: { records: (async function* () {})() },
  })),
  deleteInstallationRecords: vi.fn(async () => ({
    recordCount: 0,
    collectionCount: 0,
    alreadyDeleted: false,
  })),
  enqueueAuditEvent: vi.fn(async () => {}),
  drainAuditOutbox: vi.fn(async () => 0),
});

/** The transient failure a driver raises when the connection is gone. */
export const connectionFailure = (): Error => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/** A failure carrying a statement, which is how a record ends up inside a driver error. */
export const statementFailure = (): Error =>
  Object.assign(new Error('null value in column "value"'), {
    code: "23502",
    detail: 'Failing row contains (post-1, {"external_id": "customer-secret"})',
  });
