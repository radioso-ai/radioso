import { describe, expect, it, vi } from "vitest";

import {
  withActionRequestPushEvents,
  withChunkPushEvents,
  withConversationOwnershipPushEvents,
  withConversationPushEvents,
  withDocumentPushEvents,
  withPendingDecisionPushEvents,
  withWebsiteCrawlPushEvents,
} from "../../src/app/composition/workspacePushRepositoryDecorators.js";
import type { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { ConversationOwnershipRepository } from "../../src/db/repositories/conversationOwnershipRepository.js";
import type { PendingDecisionRepository } from "../../src/db/repositories/pendingDecisionRepository.js";
import type { WebsiteCrawlJobRepositoryPort } from "../../src/db/repositories/websiteCrawlJobRepository.js";
import type { ChunkRepositoryPort, DocumentRepositoryPort } from "../../src/modules/documents/contracts/index.js";
import { InMemoryWorkspaceEventBus } from "../../src/shared/events/workspaceEventBus.js";

describe("workspace push repository decorators", () => {
  it("publishes document status changes only after successful writes", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const repository = withDocumentPushEvents({
      setStatus: vi.fn().mockResolvedValue({ id: "document-1" }),
      setStatusIfRevisionMatches: vi.fn().mockResolvedValue(null),
    } as unknown as DocumentRepositoryPort, bus);

    await repository.setStatus({ documentId: "document-1", workspaceId: "workspace-1", status: "processing" });
    await repository.setStatusIfRevisionMatches({
      documentId: "document-1",
      workspaceId: "workspace-1",
      revision: 1,
      status: "ready",
    });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        resourceType: "document",
        resourceId: "document-1",
        workspaceId: "workspace-1",
        changeKind: "document.status_changed",
      },
    });
    await events.return?.();
  });

  it("publishes document readiness after chunk publication and crawl checkpoints", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const chunks = withChunkPushEvents(
      { publishForDocumentRevision: vi.fn().mockResolvedValue(true) } as unknown as ChunkRepositoryPort,
      bus,
    );
    const crawl = withWebsiteCrawlPushEvents(
      {
        updateCheckpoint: vi.fn().mockResolvedValue(undefined),
        markCompleted: vi.fn().mockResolvedValue({ id: "crawl-1", workspaceId: "workspace-1" }),
      } as unknown as WebsiteCrawlJobRepositoryPort,
      bus,
    );

    await chunks.publishForDocumentRevision({
      documentId: "document-1",
      workspaceId: "workspace-1",
      revision: 1,
      chunks: [],
      embeddingSpace: { id: "space-1", dimensions: 1536, distanceMetric: "cosine" },
      canonicalVersion: "1",
    });
    await crawl.updateCheckpoint("crawl-1", "workspace-1", {
      discoveredUrls: [], queuedUrls: [], processingUrls: [], processedCanonicalUrls: [],
      accepted: 0, skipped: 0, failed: 0, lastProcessedAt: null,
    });

    const completed = await crawl.markCompleted("crawl-1", {});

    expect(completed).toMatchObject({ id: "crawl-1", workspaceId: "workspace-1" });
    await expect(events.next()).resolves.toMatchObject({ value: { changeKind: "document.status_changed" } });
    await expect(events.next()).resolves.toMatchObject({
      value: { resourceId: "crawl-1", changeKind: "crawl.progress" },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: { resourceId: "crawl-1", changeKind: "crawl.status_changed" },
    });
    await events.return?.();
  });

  it("publishes conversation creation and touches", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const repository = withConversationPushEvents({
      create: vi.fn().mockResolvedValue({ id: "conversation-1", workspaceId: "workspace-1" }),
      touch: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConversationRepositoryPort, bus);

    await repository.create("workspace-1");
    await repository.touch("conversation-1", "workspace-1");

    await expect(events.next()).resolves.toMatchObject({
      value: {
        resourceType: "conversation",
        resourceId: "conversation-1",
        workspaceId: "workspace-1",
        changeKind: "conversation.created",
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        resourceType: "conversation",
        resourceId: "conversation-1",
        workspaceId: "workspace-1",
        changeKind: "conversation.updated",
      },
    });
    await events.return?.();
  });

  it("publishes ownership transitions", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const record = { conversationId: "conversation-1", workspaceId: "workspace-1" };
    const repository = withConversationOwnershipPushEvents({
      requestHandoff: vi.fn().mockResolvedValue(record),
      takeOver: vi.fn().mockResolvedValue({ ok: true, record }),
      transfer: vi.fn().mockResolvedValue({ ok: true, record }),
      handBack: vi.fn().mockResolvedValue({ ok: true, record }),
    } as unknown as ConversationOwnershipRepository, bus);

    await repository.requestHandoff({ conversationId: "conversation-1", workspaceId: "workspace-1", reason: "operator_requested" } as never);
    await repository.takeOver({ conversationId: "conversation-1", workspaceId: "workspace-1", accountId: "account-1", displayName: "Operator" });
    await repository.transfer({ conversationId: "conversation-1", accountId: "account-2", displayName: "Operator 2", expectedVersion: 1 });
    await repository.handBack({ conversationId: "conversation-1", expectedVersion: 2 });

    for (let index = 0; index < 4; index += 1) {
      await expect(events.next()).resolves.toMatchObject({
        value: {
          resourceType: "conversation",
          resourceId: "conversation-1",
          workspaceId: "workspace-1",
          changeKind: "conversation.ownership_changed",
        },
      });
    }
    await events.return?.();
  });

  it("publishes contact delivery only for transitioned action rows", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const request = { id: "request-1", workspaceId: "workspace-1", conversationId: "conversation-1" };
    const repository = withActionRequestPushEvents({
      claimPending: vi.fn().mockResolvedValue([request]),
      markDispatched: vi.fn().mockResolvedValue(true),
      recordFailure: vi.fn().mockResolvedValue("retry"),
    } as unknown as ActionRequestRepository, bus);

    await repository.claimPending(20, 300);
    await repository.recordFailure("request-1", "temporary", 1, 5, 60);
    // A retried row is only acted on again after a fresh claim re-tracks it.
    await repository.claimPending(20, 300);
    await repository.markDispatched("request-1", 1);

    for (let index = 0; index < 4; index += 1) {
      await expect(events.next()).resolves.toMatchObject({
        value: {
          resourceType: "conversation",
          resourceId: "conversation-1",
          workspaceId: "workspace-1",
          changeKind: "conversation.contact_delivery_changed",
        },
      });
    }
    await events.return?.();
  });

  it("does not publish for an empty action claim", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const repository = withActionRequestPushEvents({
      claimPending: vi.fn().mockResolvedValue([]),
      markDispatched: vi.fn().mockResolvedValue(false),
      recordFailure: vi.fn().mockResolvedValue("superseded"),
    } as unknown as ActionRequestRepository, bus);

    await repository.claimPending(20, 300);
    await expect(Promise.race([events.next(), Promise.resolve("no-event")])).resolves.toBe("no-event");
    await events.return?.();
  });

  it("publishes HITL creation and resolution", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const record = { id: "decision-1", workspaceId: "workspace-1" };
    const repository = withPendingDecisionPushEvents({
      create: vi.fn().mockResolvedValue(record),
      resolve: vi.fn().mockResolvedValue(record),
      resolveInTransaction: vi.fn(async (_input, callback) => callback(record, {} as never)),
    } as unknown as PendingDecisionRepository, bus);

    await repository.create({} as never);
    await repository.resolve({} as never);
    await repository.resolveInTransaction({} as never, async () => undefined);

    await expect(events.next()).resolves.toMatchObject({ value: { resourceType: "hitl_decision", resourceId: "decision-1", workspaceId: "workspace-1", changeKind: "hitl.decision_created" } });
    await expect(events.next()).resolves.toMatchObject({ value: { resourceType: "hitl_decision", resourceId: "decision-1", workspaceId: "workspace-1", changeKind: "hitl.decision_resolved" } });
    await expect(events.next()).resolves.toMatchObject({ value: { resourceType: "hitl_decision", resourceId: "decision-1", workspaceId: "workspace-1", changeKind: "hitl.decision_resolved" } });
    await events.return?.();
  });

  it("keeps `this` bound for intercepted methods on class-based repositories", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    class FakePendingDecisionRepository {
      private readonly record = { id: "decision-1", workspaceId: "workspace-1" };
      async create(): Promise<{ id: string; workspaceId: string }> {
        return this.record;
      }
      async resolve(): Promise<{ id: string; workspaceId: string }> {
        return this.record;
      }
      async resolveInTransaction(): Promise<undefined> {
        void this.record;
        return undefined;
      }
    }
    const repository = withPendingDecisionPushEvents(
      new FakePendingDecisionRepository() as unknown as PendingDecisionRepository,
      bus,
    );

    await expect(repository.create({} as never)).resolves.toMatchObject({ id: "decision-1" });

    class FakeActionRequestRepository {
      private readonly rows = [{ id: "request-1", workspaceId: "workspace-1", conversationId: "conversation-1" }];
      async claimPending(): Promise<Array<{ id: string; workspaceId: string; conversationId: string }>> {
        return this.rows;
      }
      async markDispatched(): Promise<boolean> {
        return this.rows.length > 0;
      }
      async recordFailure(): Promise<string> {
        void this.rows;
        return "retry";
      }
    }
    const actions = withActionRequestPushEvents(
      new FakeActionRequestRepository() as unknown as ActionRequestRepository,
      bus,
    );

    await expect(actions.claimPending(1, 60)).resolves.toHaveLength(1);
    await expect(actions.markDispatched("request-1", 1)).resolves.toBe(true);
  });
});
