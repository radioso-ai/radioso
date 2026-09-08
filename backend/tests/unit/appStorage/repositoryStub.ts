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
  setRetention: vi.fn(async () => ({ admitted: true as const, value: undefined })),
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
    value: { recordCount: 0, byteSize: 0 },
  })),
  rebuildIndexBatch: vi.fn(async () => ({
    admitted: true as const,
    value: { rebuiltCount: 0, lastKey: null },
  })),
  listCollectionsWithExpiredRecords: vi.fn(async () => []),
  reclaimExpiredRecords: vi.fn(async () => 0),
  listInstallationsDueForRetention: vi.fn(async () => []),
  streamInstallationRecords: vi.fn(() => (async function* () {})()),
  deleteInstallationRecords: vi.fn(async () => ({
    admitted: true as const,
    value: { recordCount: 0, collectionCount: 0 },
  })),
  deleteWorkspaceRecords: vi.fn(async () => ({ recordCount: 0, installationCount: 0 })),
});

/** The transient failure a driver raises when the connection is gone. */
export const connectionFailure = (): Error => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/** A failure carrying a statement, which is how a record ends up inside a driver error. */
export const statementFailure = (): Error =>
  Object.assign(new Error('null value in column "value"'), {
    code: "23502",
    detail: 'Failing row contains (post-1, {"external_id": "customer-secret"})',
  });
