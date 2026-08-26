import { describe, expect, it, vi } from "vitest";

import { createRealtimePublisherComposition } from "../../../src/app/composition/realtimePublisherComposition.js";
import { DocumentDeletionService } from "../../../src/modules/documents/services/documentDeletionService.js";
import { parseRealtimeConfig } from "../../../src/modules/realtime/infrastructure/config.js";

const saturatedWorkspaceId = "11111111-1111-4111-8111-111111111111";
const mutationWorkspaceId = "22222222-2222-4222-8222-222222222222";

describe("realtime producer mutation isolation", () => {
  it("does not await broker acceptance when a representative mutation hits producer saturation", async () => {
    let signalPublishStarted!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      signalPublishStarted = resolve;
    });
    let acceptBrokerPublish!: () => void;
    const brokerAcceptance = new Promise<void>((resolve) => {
      acceptBrokerPublish = resolve;
    });
    const publish = vi.fn(async () => {
      signalPublishStarted();
      await brokerAcceptance;
    });
    const composition = createRealtimePublisherComposition({
      config: parseRealtimeConfig({
        REALTIME_MODE: "standalone",
        REALTIME_REDIS_URL: "redis://localhost",
        REALTIME_ROLLOUT_MODE: "default-on",
        REALTIME_PRODUCER_MAX_PENDING_WORKSPACES: 1,
        REALTIME_PRODUCER_FLUSH_BATCH_SIZE: 1,
        REALTIME_PRODUCER_PUBLISH_CONCURRENCY: 1,
      }),
      transport: { publish },
    });
    composition.publisher.enqueue(saturatedWorkspaceId, ["crawl.progress"]);
    const flush = (composition.publisher as unknown as { flushNow(): Promise<void> }).flushNow();
    await publishStarted;

    const auditRecord = vi.fn(async () => undefined);
    const service = new DocumentDeletionService(
      {
        findByIdAndWorkspaceId: vi.fn(async () => ({
          id: "document-1",
          workspaceId: mutationWorkspaceId,
          sourceKind: "inline_text",
        })) as never,
        deleteByIdAndWorkspaceId: vi.fn(async () => true),
      },
      {
        upload: vi.fn(),
        read: vi.fn(),
        delete: vi.fn(),
      } as never,
      { record: auditRecord } as never,
      undefined,
      composition.publisher,
    );

    await expect(service.delete({
      workspaceId: mutationWorkspaceId,
      documentId: "document-1",
    })).resolves.toBeUndefined();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ eventStatus: "success" }));
    expect(publish).toHaveBeenCalledTimes(1);

    acceptBrokerPublish();
    await flush;
    await composition.shutdown();
  });
});
