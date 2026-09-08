import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import type {
  AppStorageRepositoryPort,
  AppStorageTransactionHandle,
} from "../../../src/modules/appStorage/public.js";

/** A stand-in for the opaque handle the repository hands work that shares its transaction. */
const transactionHandle = {} as unknown as AppStorageTransactionHandle;

/**
 * A repository that admits everything and stores nothing. Every method answers
 * `admitted`, because admission is the repository's own decision inside the
 * operation's transaction — a service test that wanted to observe a refusal
 * replaces the one method it is about.
 */
export const buildRepositoryStub = (): AppStorageRepositoryPort => ({
  findInstallationState: vi.fn(async () => null),
  setAccessRevoked: vi.fn(async () => ({
    admitted: true as const,
    value: { outcome: "applied" as const },
  })),
  setRetention: vi.fn(async (input) => ({
    admitted: true as const,
    value: { retainUntil: input.retainUntil, accessRevokedAt: new Date("2026-01-01T00:00:00.000Z") },
  })),
  cancelRetention: vi.fn(async () => ({ admitted: true as const, value: { retainUntil: null } })),
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
  beginIndexRebuild: vi.fn(async () => ({
    admitted: true as const,
    value: { startVersion: 1, generation: 1 },
  })),
  rebuildIndexBatch: vi.fn(async () => ({
    admitted: true as const,
    value: { rebuiltCount: 0, lastKey: null, visitedKeys: [], incompatibleKeys: [] },
  })),
  finishIndexRebuild: vi.fn(async () => ({
    admitted: true as const,
    value: { outcome: "finished" as const, completionToken: "sync_state:by_external_id:1" },
  })),
  completeIndexRebuild: vi.fn(async () => ({ outcome: "completed" as const })),
  cancelIndexRebuild: vi.fn(async () => ({
    admitted: true as const,
    value: { outcome: "cancelled" as const },
  })),
  runInTransaction: vi.fn(async (work) => work(transactionHandle)),
  listExpirySweepCandidates: vi.fn(async () => []),
  claimCollectionForExpirySweep: vi.fn(async () => ({
    claimed: true as const,
    leaseToken: randomUUID(),
  })),
  reclaimExpiredRecords: vi.fn(async () => 0),
  listInstallationsDueForRetention: vi.fn(async () => []),
  reclaimRetainedInstallation: vi.fn(async () => ({
    outcome: "reclaimed" as const,
    summary: { recordCount: 0, collectionCount: 0 },
  })),
  openInstallationExport: vi.fn(async () => ({
    admitted: true as const,
    value: { read: () => (async function* () {})(), close: async (): Promise<void> => undefined },
  })),
  deleteInstallationRecords: vi.fn(async () => ({
    recordCount: 0,
    collectionCount: 0,
    alreadyDeleted: false,
  })),
  enqueueAuditEvent: vi.fn(async () => {}),
  claimAuditOutboxBatch: vi.fn(async () => ({ claimToken: randomUUID(), entries: [] })),
  acknowledgeAuditOutbox: vi.fn(async () => 0),
});

/** The transient failure a driver raises when the connection is gone. */
export const connectionFailure = (): Error => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/** A failure carrying a statement, which is how a record ends up inside a driver error. */
export const statementFailure = (): Error =>
  Object.assign(new Error('null value in column "value"'), {
    code: "23502",
    detail: 'Failing row contains (post-1, {"external_id": "customer-secret"})',
  });
