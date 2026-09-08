import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildRepositoryStub, connectionFailure, statementFailure } from "./repositoryStub.js";
import {
  createAppStorageDisposition,
  MAX_RETENTION_DAYS,
  type AppStorageAuditIntent,
  type AppStorageAuditPort,
  type AppStorageExportEvent,
  type AppStorageRepositoryPort,
  type StoredAppStorageRecord,
} from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();
const scope = { workspaceId, installationId };
const now = new Date("2026-09-07T10:00:00.000Z");

const record = (collectionId: string, key: string): StoredAppStorageRecord & { collectionId: string } => ({
  collectionId,
  key,
  version: 2,
  schemaVersion: 1,
  updatedAt: new Date("2026-09-07T09:00:00.000Z"),
  value: { external_id: key },
});

const buildRepository = (): AppStorageRepositoryPort => {
  const repository = buildRepositoryStub();
  repository.openInstallationExport = vi.fn(async () => ({
    admitted: true as const,
    value: {
      read: () =>
        (async function* () {
          yield record("sync_state", "post-1");
          yield record("cursors", "cursor-1");
        })(),
      close: async (): Promise<void> => undefined,
    },
  }));
  repository.deleteInstallationRecords = vi.fn(async () => ({
    recordCount: 4,
    collectionCount: 2,
    alreadyDeleted: false,
  }));
  return repository;
};

describe("app storage disposition", () => {
  let repository: AppStorageRepositoryPort;
  let audit: AppStorageAuditPort & { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repository = buildRepository();
    audit = { record: vi.fn(async () => undefined) };
  });

  const disposition = () => createAppStorageDisposition({ repository, audit, now: () => now });

  /**
   * What the disposition committed to the trail. An irreversible change writes
   * its intent inside its own transaction, so the intent is either on the outbox
   * directly or built by the callback that transaction invoked.
   */
  const enqueued = (): AppStorageAuditIntent[] =>
    (repository.enqueueAuditEvent as ReturnType<typeof vi.fn>).mock.calls.map(([call]) => call.intent);

  const eventTypes = (): string[] => enqueued().map((intent) => intent.eventType);

  /** Drains an admitted export, returning every event it produced. */
  const drain = async (stop?: number): Promise<AppStorageExportEvent[]> => {
    const admission = await disposition().export(scope);
    if (!admission.ok) throw new Error("export was not admitted");

    const events: AppStorageExportEvent[] = [];
    for await (const event of admission.snapshot.stream()) {
      events.push(event);
      if (stop !== undefined && events.length >= stop) break;
    }
    return events;
  };

  it("revokes storage access without removing a record", async () => {
    await disposition().revokeAccess(scope);
    expect(repository.setAccessRevoked).toHaveBeenCalledWith(scope, now);
    expect(repository.deleteInstallationRecords).not.toHaveBeenCalled();
  });

  it("restores storage access by clearing the revocation", async () => {
    await expect(disposition().restoreAccess(scope)).resolves.toEqual({ ok: true, value: undefined });
    expect(repository.setAccessRevoked).toHaveBeenCalledWith(scope, null);
  });

  it("refuses to restore access while a retention hold stands", async () => {
    // Restoring here would hand a running App data the retention sweep is going
    // to destroy. The repository decides it under the state row; what this layer
    // owes is a refusal the operator can act on.
    repository.setAccessRevoked = vi.fn(async () => ({
      admitted: true as const,
      value: { outcome: "retention_active" as const, retainUntil: new Date("2026-10-07T10:00:00.000Z") },
    }));

    await expect(disposition().restoreAccess(scope)).resolves.toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
  });

  it("cancels a retention hold, audits it, and leaves access revoked", async () => {
    const held = new Date("2026-10-07T10:00:00.000Z");
    repository.cancelRetention = vi.fn(async (input) => {
      input.audit({ retainUntil: held });
      return { admitted: true as const, value: { retainUntil: held } };
    });

    await expect(disposition().cancelRetention(scope)).resolves.toEqual({
      ok: true,
      value: { retainUntil: held },
    });
    expect(repository.setAccessRevoked).not.toHaveBeenCalled();

    const [call] = (repository.cancelRetention as ReturnType<typeof vi.fn>).mock.calls;
    expect(call?.[0].audit({ retainUntil: held })).toMatchObject({
      eventType: "app.data.retention.changed",
      eventStatus: "success",
      metadata: { cancelled: true, retainUntil: held.toISOString() },
    });
  });

  it("treats cancelling a hold that is not there as the state the caller asked for", async () => {
    await expect(disposition().cancelRetention(scope)).resolves.toEqual({
      ok: true,
      value: { retainUntil: null },
    });
  });

  it("refuses revocation and retention against an installation the tombstone covers", async () => {
    const notAdmitted = { admitted: false as const };
    repository.setAccessRevoked = vi.fn(async () => notAdmitted);
    repository.setRetention = vi.fn(async () => notAdmitted);

    const denied = { ok: false, error: { code: "denied", message: expect.any(String) } };
    await expect(disposition().revokeAccess(scope)).resolves.toMatchObject(denied);
    await expect(
      disposition().retain({ ...scope, until: new Date("2026-09-08T10:00:00.000Z") }),
    ).resolves.toMatchObject(denied);
  });

  it("refuses an export against a tombstoned installation rather than handing back an empty one", async () => {
    // An empty stream is indistinguishable from an installation that held no
    // records, and the difference is whether the operator has the data or not.
    repository.openInstallationExport = vi.fn(async () => ({ admitted: false as const }));

    const admission = await disposition().export(scope);

    expect(admission).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.cancelled"]);
  });

  it("exports one JSON line per record, grouped by collection", async () => {
    const events = await drain();
    const lines = events.flatMap((event) => (event.kind === "line" ? [event] : []));

    expect(lines.map((line) => line.collectionId)).toEqual(["sync_state", "cursors"]);
    expect(JSON.parse(lines[0]?.line ?? "{}")).toEqual({
      collection: "sync_state",
      key: "post-1",
      version: 2,
      schemaVersion: 1,
      updatedAt: "2026-09-07T09:00:00.000Z",
      record: { external_id: "post-1" },
    });
  });

  it("audits an export as requested and then completed, carrying counts rather than data", async () => {
    await drain();

    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.completed"]);
    const [, completed] = enqueued();
    expect(completed).toMatchObject({
      eventStatus: "success",
      metadata: { recordCount: 2, collectionCount: 2 },
    });
    expect(JSON.stringify(completed)).not.toContain("post-1");
  });

  it("audits an export whose consumer stops early as cancelled, with what had been handed over", async () => {
    await drain(1);

    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.cancelled"]);
    expect(enqueued()[1]).toMatchObject({
      eventStatus: "failure",
      metadata: { recordCount: 1, collectionCount: 1, reason: "consumer_stopped" },
    });
  });

  it("ends an export that fails part-way with a typed error event rather than with EOF", async () => {
    repository.openInstallationExport = vi.fn(async () => ({
      admitted: true as const,
      value: {
        read: () =>
          (async function* () {
            yield record("sync_state", "post-1");
            throw statementFailure();
          })(),
        close: async (): Promise<void> => undefined,
      },
    }));

    const events = await drain();

    expect(events.map((event) => event.kind)).toEqual(["line", "error"]);
    expect(events[1]).toMatchObject({ kind: "error", error: { code: "internal" } });
    expect(JSON.stringify(events[1])).not.toContain("customer-secret");
    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.cancelled"]);
    expect(enqueued()[1]).toMatchObject({ eventStatus: "failure", metadata: { recordCount: 1 } });
  });

  it("revokes access as part of retaining, so retained data is data the App cannot reach", async () => {
    const until = new Date("2026-10-07T10:00:00.000Z");
    const revokedAt = new Date("2026-09-07T10:00:00.000Z");
    repository.setRetention = vi.fn(async (input) => {
      // The repository builds the trail entry from what it actually applied, and
      // commits it with the change.
      input.audit({ retainUntil: input.retainUntil, accessRevokedAt: revokedAt });
      return { admitted: true as const, value: { retainUntil: input.retainUntil, accessRevokedAt: revokedAt } };
    });

    await expect(disposition().retain({ ...scope, until })).resolves.toEqual({
      ok: true,
      value: { retainUntil: until },
    });

    const [call] = (repository.setRetention as ReturnType<typeof vi.fn>).mock.calls;
    expect(call?.[0]).toMatchObject({ scope, retainUntil: until });
    expect(call?.[0].audit({ retainUntil: until, accessRevokedAt: revokedAt })).toMatchObject({
      eventType: "app.data.retention.changed",
      eventStatus: "success",
      metadata: { retainUntil: until.toISOString(), accessRevokedAt: revokedAt.toISOString() },
    });
  });

  it("accepts a deadline exactly at the policy ceiling", async () => {
    const until = new Date(now.getTime() + MAX_RETENTION_DAYS * 86_400_000);
    await expect(disposition().retain({ ...scope, until })).resolves.toEqual({
      ok: true,
      value: { retainUntil: until },
    });
  });

  it("refuses a deadline that is past, invalid, or beyond the policy ceiling", async () => {
    const beyond = new Date(now.getTime() + (MAX_RETENTION_DAYS + 1) * 86_400_000);
    for (const until of [new Date("2026-09-06T10:00:00.000Z"), new Date(Number.NaN), beyond]) {
      await expect(disposition().retain({ ...scope, until })).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }

    expect(repository.setRetention).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual([
      "app.data.retention.changed",
      "app.data.retention.changed",
      "app.data.retention.changed",
    ]);
    expect(enqueued().every((intent) => intent.eventStatus === "failure")).toBe(true);
  });

  it("deletes an installation's records and commits the completion with the deletion", async () => {
    const result = await disposition().deleteInstallationStorage(scope);

    expect(result).toEqual({ ok: true, value: { recordCount: 4, collectionCount: 2 } });
    expect(eventTypes()).toEqual(["app.data.deletion.requested"]);

    const [call] = (repository.deleteInstallationRecords as ReturnType<typeof vi.fn>).mock.calls;
    expect(call?.[0].audit({ recordCount: 4, collectionCount: 2 })).toMatchObject({
      eventType: "app.data.deletion.completed",
      eventStatus: "success",
      metadata: { recordCount: 4, collectionCount: 2 },
    });
  });

  it("answers a repeated deletion with the counts the committed one recorded", async () => {
    // Deletion is irreversible and its caller may have lost the first response to
    // a crashed process or a retried job. Refusing the retry would leave that
    // caller unable to learn what happened to the data.
    repository.deleteInstallationRecords = vi.fn(async () => ({
      recordCount: 4,
      collectionCount: 2,
      alreadyDeleted: true,
    }));

    await expect(disposition().deleteInstallationStorage(scope)).resolves.toEqual({
      ok: true,
      value: { recordCount: 4, collectionCount: 2 },
    });
  });

  it("reports a deletion that failed as a failure and records it as one", async () => {
    repository.deleteInstallationRecords = vi.fn(async () => {
      throw statementFailure();
    });

    const result = await disposition().deleteInstallationStorage(scope);

    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(result)).not.toContain("customer-secret");
    // A trail showing a deletion requested and nothing afterwards cannot
    // distinguish a deletion that failed from one whose event was never written.
    expect(eventTypes()).toEqual(["app.data.deletion.requested", "app.data.deletion.completed"]);
    expect(enqueued()[1]).toMatchObject({ eventStatus: "failure", metadata: { reason: "internal" } });
    expect(JSON.stringify(enqueued())).not.toContain("customer-secret");
  });

  it("keeps the deletion's own failure when recording it fails too", async () => {
    // A secondary audit write must never replace the primary answer: the caller
    // asked what became of the data, not whether the outbox was reachable.
    repository.deleteInstallationRecords = vi.fn(async () => {
      throw statementFailure();
    });
    repository.enqueueAuditEvent = vi.fn(async (input) => {
      if (input.intent.eventStatus === "failure") throw connectionFailure();
    });

    await expect(disposition().deleteInstallationStorage(scope)).resolves.toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  });

  it("keeps an invalid retention deadline's own refusal when recording it fails", async () => {
    repository.enqueueAuditEvent = vi.fn(async () => {
      throw connectionFailure();
    });

    await expect(
      disposition().retain({ ...scope, until: new Date("2026-09-06T10:00:00.000Z") }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("keeps a refused export's own refusal when recording the cancellation fails", async () => {
    repository.openInstallationExport = vi.fn(async () => ({ admitted: false as const }));
    repository.enqueueAuditEvent = vi.fn(async (input) => {
      if (input.intent.eventType === "app.data.export.cancelled") throw connectionFailure();
    });

    await expect(disposition().export(scope)).resolves.toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
  });

  it("says an intent that was not committed out loud, in identifiers and codes", async () => {
    // Not replacing the primary answer is half the rule; the other half is that
    // an outbox outage during a refusal must not be silent, or the only symptom
    // is trail entries nobody ever notices are missing.
    const logger = { warn: vi.fn() };
    repository.openInstallationExport = vi.fn(async () => ({ admitted: false as const }));
    repository.enqueueAuditEvent = vi.fn(async (input) => {
      if (input.intent.eventType === "app.data.export.cancelled") throw connectionFailure();
    });

    const refused = await createAppStorageDisposition({
      repository,
      audit,
      logger,
      now: () => now,
    }).export(scope);

    expect(refused).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        installationId,
        workspaceId,
        eventType: "app.data.export.cancelled",
        eventStatus: "failure",
        failureCode: "unavailable",
      },
      expect.any(String),
    );
  });

  it("closes the snapshot when the consumer walks away mid-stream", async () => {
    // A repeatable-read snapshot pins a connection and an MVCC snapshot. The
    // consumer's `break` is what has to end it, not the idle timeout.
    const close = vi.fn(async () => undefined);
    repository.openInstallationExport = vi.fn(async () => ({
      admitted: true as const,
      value: {
        read: () =>
          (async function* () {
            yield record("sync_state", "post-1");
            yield record("sync_state", "post-2");
          })(),
        close,
      },
    }));

    await drain(1);

    expect(close).toHaveBeenCalled();
  });

  it("opens nothing when an admitted export is never read", async () => {
    const read = vi.fn(() => (async function* () {})());
    repository.openInstallationExport = vi.fn(async () => ({
      admitted: true as const,
      value: { read, close: async (): Promise<void> => undefined },
    }));

    const admission = await disposition().export(scope);

    expect(admission.ok).toBe(true);
    // Admission is a decision, not a transaction. Reading is what opens one.
    expect(read).not.toHaveBeenCalled();
  });

  it("publishes claimed intents outside the claim, then acknowledges them by token", async () => {
    // The audit store is the same database, so publishing while the claim's
    // transaction is open needs a second pooled connection and holds row locks
    // across the publisher. The claim commits first; the acknowledgement carries
    // the token that leased the rows.
    repository.claimAuditOutboxBatch = vi.fn(async () => ({
      claimToken: "claim-1",
      entries: [
        {
          eventId: "event-1",
          workspaceId,
          deletedWorkspaceId: null,
          installationId,
          eventType: "app.data.deletion.completed" as const,
          eventStatus: "success" as const,
          metadata: { recordCount: 4, collectionCount: 2 },
          attemptCount: 1,
        },
      ],
    }));

    await expect(disposition().drainAuditOutbox()).resolves.toEqual({
      publishedCount: 1,
      failureCount: 0,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "event-1", eventType: "app.data.deletion.completed", workspaceId }),
    );
    expect(repository.acknowledgeAuditOutbox).toHaveBeenCalledWith({
      claimToken: "claim-1",
      eventIds: ["event-1"],
    });
  });

  it("leaves an entry whose publish failed unacknowledged, for the next pass to retry", async () => {
    repository.claimAuditOutboxBatch = vi.fn(async () => ({
      claimToken: "claim-1",
      entries: [
        {
          eventId: "kept",
          workspaceId,
          deletedWorkspaceId: null,
          installationId,
          eventType: "app.data.export.requested" as const,
          eventStatus: "success" as const,
          metadata: {},
          attemptCount: 1,
        },
        {
          eventId: "published",
          workspaceId,
          deletedWorkspaceId: null,
          installationId,
          eventType: "app.data.export.completed" as const,
          eventStatus: "success" as const,
          metadata: {},
          attemptCount: 1,
        },
      ],
    }));
    let firstPublish = true;
    audit.record = vi.fn(async () => {
      if (!firstPublish) return;
      firstPublish = false;
      throw statementFailure();
    });

    await expect(disposition().drainAuditOutbox()).resolves.toEqual({
      publishedCount: 1,
      failureCount: 1,
    });
    // Only the one that landed is acknowledged; the other keeps its lease and is
    // claimed again once the lease expires.
    expect(repository.acknowledgeAuditOutbox).toHaveBeenCalledWith({
      claimToken: "claim-1",
      eventIds: ["published"],
    });
  });
});
