import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAuditOutboxDispatcher } from "../../../src/modules/audit/composition.js";
import type {
  AuditOutboxClaim,
  AuditOutboxRepositoryPort,
  ClaimedAuditOutboxEntry,
} from "../../../src/modules/audit/composition.js";
import type { AuditEventInput, AuditPort } from "../../../src/modules/audit/contracts/index.js";
import type { AppLogger } from "../../../src/shared/observability/logger.js";

const entry = (overrides: Partial<ClaimedAuditOutboxEntry> = {}): ClaimedAuditOutboxEntry => ({
  eventId: randomUUID(),
  accountId: null,
  workspaceId: randomUUID(),
  deletedWorkspaceId: null,
  eventType: "app.data.deletion.completed",
  eventStatus: "success",
  metadata: { recordCount: 2 },
  attemptCount: 1,
  ...overrides,
});

const buildRepository = (claim: AuditOutboxClaim): AuditOutboxRepositoryPort & {
  claim: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
} => ({
  enqueue: vi.fn(async () => []),
  claim: vi.fn(async () => claim),
  acknowledge: vi.fn(async (input: { eventIds: readonly string[] }) => input.eventIds.length),
});

const buildLogger = (): Pick<AppLogger, "warn"> & { warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  return { warn } as Pick<AppLogger, "warn"> & { warn: ReturnType<typeof vi.fn> };
};

describe("audit outbox dispatcher", () => {
  it("publishes every claimed entry and acknowledges the published ids", async () => {
    const claimed = entry();
    const repository = buildRepository({ claimToken: "claim-1", entries: [claimed] });
    const recorded: AuditEventInput[] = [];
    const auditPort: AuditPort = {
      async record(event) {
        recorded.push(event);
      },
      async getLatestSuccessfulChatAnswerMetadata() {
        return null;
      },
      async updateChatAnswerSuggestions() {},
    };
    const logger = buildLogger();

    const dispatcher = createAuditOutboxDispatcher({ repository, auditPort, logger });
    const result = await dispatcher.drain({ batchSize: 10 });

    expect(result).toEqual({ published: 1, failed: 0, remaining: false });
    expect(recorded).toEqual([
      expect.objectContaining({
        eventId: claimed.eventId,
        workspaceId: claimed.workspaceId,
        eventType: claimed.eventType,
        eventStatus: claimed.eventStatus,
        metadata: expect.objectContaining({ recordCount: 2, eventId: claimed.eventId }),
      }),
    ]);
    expect(repository.acknowledge).toHaveBeenCalledWith({
      claimToken: "claim-1",
      eventIds: [claimed.eventId],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("acknowledges only the entries that published, and logs the ones that failed", async () => {
    const kept = entry({ eventId: "kept" });
    const published = entry({ eventId: "published" });
    const repository = buildRepository({ claimToken: "claim-2", entries: [kept, published] });
    let calls = 0;
    const auditPort: AuditPort = {
      async record(event) {
        calls += 1;
        if (event.eventId === "kept") throw new Error("sink down");
      },
      async getLatestSuccessfulChatAnswerMetadata() {
        return null;
      },
      async updateChatAnswerSuggestions() {},
    };
    const logger = buildLogger();

    const dispatcher = createAuditOutboxDispatcher({ repository, auditPort, logger });
    const result = await dispatcher.drain({ batchSize: 10 });

    expect(calls).toBe(2);
    expect(result).toEqual({ published: 1, failed: 1, remaining: false });
    // Only the one that landed is acknowledged; the other keeps its lease and is
    // claimed again once the lease expires.
    expect(repository.acknowledge).toHaveBeenCalledWith({
      claimToken: "claim-2",
      eventIds: ["published"],
    });
    // Identifiers only — never the metadata a failed record could carry.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      eventId: "kept",
      eventType: kept.eventType,
      workspaceId: kept.workspaceId,
      attempt: kept.attemptCount,
    });
    expect(typeof message).toBe("string");
  });

  it("maps a deleted workspace to a null workspace and a deletedWorkspaceId in metadata", async () => {
    const former = randomUUID();
    const claimed = entry({ workspaceId: null, deletedWorkspaceId: former });
    const repository = buildRepository({ claimToken: "claim-3", entries: [claimed] });
    const recorded: AuditEventInput[] = [];
    const auditPort: AuditPort = {
      async record(event) {
        recorded.push(event);
      },
      async getLatestSuccessfulChatAnswerMetadata() {
        return null;
      },
      async updateChatAnswerSuggestions() {},
    };

    const dispatcher = createAuditOutboxDispatcher({ repository, auditPort, logger: buildLogger() });
    await dispatcher.drain({ batchSize: 10 });

    expect(recorded).toEqual([
      expect.objectContaining({
        workspaceId: null,
        metadata: expect.objectContaining({ deletedWorkspaceId: former }),
      }),
    ]);
  });

  it("does not carry a deletedWorkspaceId for an entry that never named a workspace", async () => {
    const claimed = entry({ workspaceId: null, deletedWorkspaceId: null });
    const repository = buildRepository({ claimToken: "claim-4", entries: [claimed] });
    const recorded: AuditEventInput[] = [];
    const auditPort: AuditPort = {
      async record(event) {
        recorded.push(event);
      },
      async getLatestSuccessfulChatAnswerMetadata() {
        return null;
      },
      async updateChatAnswerSuggestions() {},
    };

    const dispatcher = createAuditOutboxDispatcher({ repository, auditPort, logger: buildLogger() });
    await dispatcher.drain({ batchSize: 10 });

    expect(recorded[0]?.metadata).not.toHaveProperty("deletedWorkspaceId");
  });

  it("reports remaining when a full batch was claimed, and answers empty when nothing was", async () => {
    const full = buildRepository({
      claimToken: "claim-5",
      entries: [entry(), entry()],
    });
    const auditPort: AuditPort = {
      async record() {},
      async getLatestSuccessfulChatAnswerMetadata() {
        return null;
      },
      async updateChatAnswerSuggestions() {},
    };

    const fullDispatcher = createAuditOutboxDispatcher({ repository: full, auditPort, logger: buildLogger() });
    expect(await fullDispatcher.drain({ batchSize: 2 })).toMatchObject({ remaining: true });

    const empty = buildRepository({ claimToken: "claim-6", entries: [] });
    const emptyDispatcher = createAuditOutboxDispatcher({ repository: empty, auditPort, logger: buildLogger() });
    expect(await emptyDispatcher.drain({ batchSize: 2 })).toEqual({
      published: 0,
      failed: 0,
      remaining: false,
    });
    expect(empty.acknowledge).not.toHaveBeenCalled();
  });
});
