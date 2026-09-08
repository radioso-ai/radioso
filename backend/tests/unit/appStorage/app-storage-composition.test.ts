import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import {
  createAppStorageAuditSink,
  createAppStorageComposition,
  type AppStorageComposition,
} from "../../../src/app/composition/appStorage.js";
import type { AuditEventInput, AuditService } from "../../../src/modules/audit/contracts/index.js";
import type { DB } from "../../../src/shared/infra/kysely/types.js";

const buildAuditService = (recorded: AuditEventInput[]): AuditService => ({
  async record(event) {
    recorded.push(event);
  },
  async getLatestSuccessfulChatAnswerMetadata() {
    return null;
  },
  async updateChatAnswerSuggestions() {
    // Storage writes no chat metadata.
  },
});

describe("app storage composition", () => {
  it("assembles the repository, service, disposition, rebuilder, and sweeper", () => {
    const composition: AppStorageComposition = createAppStorageComposition({
      // Composition wires implementations; nothing here reaches the connection.
      kysely: {} as Kysely<DB>,
      auditService: buildAuditService([]),
    });

    expect(typeof composition.service.put).toBe("function");
    expect(typeof composition.compatibilityFacts.storedSchemaVersions).toBe("function");
    expect(typeof composition.disposition.cancelRetention).toBe("function");
    expect(typeof composition.disposition.export).toBe("function");
    expect(typeof composition.disposition.drainAuditOutbox).toBe("function");
    expect(typeof composition.sweeper.runExpirySweep).toBe("function");
    expect(typeof composition.sweeper.runRetentionSweep).toBe("function");
    expect(typeof composition.sweeper.runIndexRebuildSweep).toBe("function");
    expect(typeof composition.indexRebuilder.rebuildIndex).toBe("function");
    expect(typeof composition.repository.findRecord).toBe("function");
  });
});

describe("app storage audit sink", () => {
  it("puts an app.data event on the audit spine with the installation as an identity", async () => {
    const recorded: AuditEventInput[] = [];
    const workspaceId = randomUUID();
    const installationId = randomUUID();

    await createAppStorageAuditSink(buildAuditService(recorded)).record({
      eventId: "event-1",
      workspaceId,
      deletedWorkspaceId: null,
      installationId,
      eventType: "app.data.deletion.completed",
      eventStatus: "success",
      metadata: { recordCount: 4, collectionCount: 2 },
    });

    expect(recorded).toEqual([
      {
        workspaceId,
        eventType: "app.data.deletion.completed",
        eventStatus: "success",
        metadata: { recordCount: 4, collectionCount: 2, installationId, eventId: "event-1" },
      },
    ]);
  });

  it("publishes an event whose workspace is gone with a null workspace and the former identifier", async () => {
    // The outbox deliberately outlives workspace deletion, and `audit_events`
    // references `workspaces`: attributing a preserved entry to a workspace row
    // that no longer exists would fail the foreign key on every retry forever.
    const recorded: AuditEventInput[] = [];
    const deletedWorkspaceId = randomUUID();
    const installationId = randomUUID();

    await createAppStorageAuditSink(buildAuditService(recorded)).record({
      eventId: "event-3",
      workspaceId: null,
      deletedWorkspaceId,
      installationId,
      eventType: "app.data.deletion.completed",
      eventStatus: "success",
      metadata: { recordCount: 1, collectionCount: 1 },
    });

    expect(recorded).toEqual([
      {
        workspaceId: null,
        eventType: "app.data.deletion.completed",
        eventStatus: "success",
        metadata: {
          recordCount: 1,
          collectionCount: 1,
          installationId,
          eventId: "event-3",
          deletedWorkspaceId,
        },
      },
    ]);
  });

  it("carries an event with no installation identity, which is what a null one means", async () => {
    const recorded: AuditEventInput[] = [];
    const workspaceId = randomUUID();
    const auditService = buildAuditService(recorded);
    const spy = vi.spyOn(auditService, "record");

    await createAppStorageAuditSink(auditService).record({
      eventId: "event-2",
      workspaceId,
      deletedWorkspaceId: null,
      installationId: null,
      eventType: "app.data.deletion.requested",
      eventStatus: "success",
      metadata: { reason: "retention_elapsed" },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(recorded[0]?.metadata).toEqual({
      reason: "retention_elapsed",
      installationId: null,
      eventId: "event-2",
    });
  });
});
