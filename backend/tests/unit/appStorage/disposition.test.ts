import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildRepositoryStub, statementFailure } from "./repositoryStub.js";
import {
  createAppStorageDisposition,
  MAX_RETENTION_DAYS,
  type AppStorageAuditPort,
  type AppStorageRepositoryPort,
  type StoredAppStorageRecord,
} from "../../../src/modules/appStorage/public.js";

const workspaceId = randomUUID();
const installationId = randomUUID();
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
  repository.streamInstallationRecords = vi.fn(() =>
    (async function* () {
      yield record("sync_state", "post-1");
      yield record("cursors", "cursor-1");
    })(),
  );
  repository.deleteInstallationRecords = vi.fn(async () => ({
    admitted: true as const,
    value: { recordCount: 4, collectionCount: 2 },
  }));
  repository.deleteWorkspaceRecords = vi.fn(async () => ({ recordCount: 9, installationCount: 3 }));
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

  const eventTypes = (): string[] => audit.record.mock.calls.map(([event]) => event.eventType);

  it("revokes storage access without removing a record", async () => {
    await disposition().revokeAccess({ workspaceId, installationId });
    expect(repository.setAccessRevoked).toHaveBeenCalledWith({ workspaceId, installationId }, now);
    expect(repository.deleteInstallationRecords).not.toHaveBeenCalled();
  });

  it("restores storage access by clearing the revocation", async () => {
    await disposition().restoreAccess({ workspaceId, installationId });
    expect(repository.setAccessRevoked).toHaveBeenCalledWith({ workspaceId, installationId }, null);
  });

  it("refuses every disposition against an installation the tombstone covers", async () => {
    const notAdmitted = { admitted: false as const };
    repository.setAccessRevoked = vi.fn(async () => notAdmitted);
    repository.setRetention = vi.fn(async () => notAdmitted);
    repository.deleteInstallationRecords = vi.fn(async () => notAdmitted);

    const denied = { ok: false, error: { code: "denied", message: expect.any(String) } };
    await expect(disposition().revokeAccess({ workspaceId, installationId })).resolves.toMatchObject(denied);
    await expect(
      disposition().retain({ workspaceId, installationId, until: new Date("2026-09-08T10:00:00.000Z") }),
    ).resolves.toMatchObject(denied);
    await expect(
      disposition().deleteInstallationStorage({ workspaceId, installationId }),
    ).resolves.toMatchObject(denied);
  });

  it("exports one JSON line per record, grouped by collection", async () => {
    const lines: { collectionId: string; line: string }[] = [];
    for await (const line of disposition().exportRecords({ workspaceId, installationId })) {
      lines.push(line);
    }

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
    for await (const _line of disposition().exportRecords({ workspaceId, installationId })) {
      // drain
    }

    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.completed"]);
    const [, completed] = audit.record.mock.calls;
    expect(completed?.[0]).toMatchObject({
      workspaceId,
      installationId,
      eventStatus: "success",
      metadata: { recordCount: 2, collectionCount: 2 },
    });
    expect(JSON.stringify(completed?.[0])).not.toContain("post-1");
  });

  it("audits an export whose consumer stops early as cancelled, with what had been handed over", async () => {
    for await (const _line of disposition().exportRecords({ workspaceId, installationId })) {
      break;
    }

    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.cancelled"]);
    expect(audit.record.mock.calls[1]?.[0]).toMatchObject({
      eventStatus: "failure",
      metadata: { recordCount: 1, collectionCount: 1 },
    });
  });

  it("audits an export that fails part-way as cancelled and lets the failure reach the caller", async () => {
    repository.streamInstallationRecords = vi.fn(() =>
      (async function* () {
        yield record("sync_state", "post-1");
        throw statementFailure();
      })(),
    );

    const drain = async (): Promise<void> => {
      for await (const _line of disposition().exportRecords({ workspaceId, installationId })) {
        // drain
      }
    };

    await expect(drain()).rejects.toThrow();
    expect(eventTypes()).toEqual(["app.data.export.requested", "app.data.export.cancelled"]);
    expect(audit.record.mock.calls[1]?.[0]).toMatchObject({ eventStatus: "failure" });
  });

  it("records a bounded retention deadline", async () => {
    const until = new Date("2026-10-07T10:00:00.000Z");
    await disposition().retain({ workspaceId, installationId, until });

    expect(repository.setRetention).toHaveBeenCalledWith({ workspaceId, installationId }, until);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "app.data.retention.changed",
        eventStatus: "success",
        metadata: expect.objectContaining({ retainUntil: until.toISOString() }),
      }),
    );
  });

  it("accepts a deadline exactly at the policy ceiling", async () => {
    const until = new Date(now.getTime() + MAX_RETENTION_DAYS * 86_400_000);
    await expect(disposition().retain({ workspaceId, installationId, until })).resolves.toEqual({
      ok: true,
      value: { retainUntil: until },
    });
  });

  it("refuses a deadline that is past, invalid, or beyond the policy ceiling", async () => {
    const beyond = new Date(now.getTime() + (MAX_RETENTION_DAYS + 1) * 86_400_000);
    for (const until of [new Date("2026-09-06T10:00:00.000Z"), new Date(Number.NaN), beyond]) {
      await expect(disposition().retain({ workspaceId, installationId, until })).resolves.toMatchObject({
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
    expect(audit.record.mock.calls.every(([event]) => event.eventStatus === "failure")).toBe(true);
  });

  it("deletes an installation's records and audits the request and the result", async () => {
    const result = await disposition().deleteInstallationStorage({ workspaceId, installationId });

    expect(result).toEqual({ ok: true, value: { recordCount: 4, collectionCount: 2 } });
    expect(eventTypes()).toEqual(["app.data.deletion.requested", "app.data.deletion.completed"]);
    expect(audit.record.mock.calls[1]?.[0]).toMatchObject({ eventStatus: "success" });
  });

  it("audits a deletion that failed as a failure rather than as zero records removed", async () => {
    repository.deleteInstallationRecords = vi.fn(async () => {
      throw statementFailure();
    });

    const result = await disposition().deleteInstallationStorage({ workspaceId, installationId });

    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(audit.record.mock.calls[1]?.[0]).toMatchObject({
      eventType: "app.data.deletion.completed",
      eventStatus: "failure",
    });
    expect(JSON.stringify(audit.record.mock.calls[1]?.[0])).not.toContain("customer-secret");
  });

  it("deletes every installation's records when a workspace is deleted", async () => {
    const result = await disposition().deleteWorkspaceStorage({ workspaceId });

    expect(result).toEqual({ recordCount: 9, installationCount: 3 });
    expect(repository.deleteWorkspaceRecords).toHaveBeenCalledWith(workspaceId);
    expect(eventTypes()).toEqual(["app.data.deletion.requested", "app.data.deletion.completed"]);
  });
});
