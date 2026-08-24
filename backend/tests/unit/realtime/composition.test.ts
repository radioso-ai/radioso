import { describe, expect, it, vi } from "vitest";
import { createRealtimePublisherComposition } from "../../../src/app/composition/realtimePublisherComposition.js";
import { parseRealtimeConfig } from "../../../src/modules/realtime/infrastructure/config.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";

describe("realtime publisher composition", () => {
  it("selects a no-op publisher when realtime is disabled", () => {
    const composition = createRealtimePublisherComposition({ config: parseRealtimeConfig({ REALTIME_MODE: "disabled" }) });
    expect(composition.publisher.enqueue(workspaceId, ["crawl.progress"])).toMatchObject({ accepted: false, reason: "disabled" });
  });

  it("validates enabled startup inputs and keeps mutation enqueue independent of broker failures", async () => {
    expect(() => createRealtimePublisherComposition({ config: parseRealtimeConfig({ REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "default-on" }) })).toThrow(/transport/i);
    const publish = vi.fn().mockRejectedValue(new Error("broker unavailable"));
    const composition = createRealtimePublisherComposition({ config: parseRealtimeConfig({ REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "default-on" }), transport: { publish } });
    expect(composition.publisher.enqueue(workspaceId, ["crawl.progress"])).toMatchObject({ accepted: true });
    await composition.shutdown();
    expect(publish).toHaveBeenCalled();
  });

  it("passes the low-cardinality producer telemetry adapter through composition", async () => {
    const outcomes: string[] = [];
    const composition = createRealtimePublisherComposition({
      config: parseRealtimeConfig({ REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "default-on" }),
      transport: { publish: async () => undefined },
      telemetry: {
        producer: {
          enqueue: (outcome) => outcomes.push(`enqueue:${outcome}`),
          publish: (outcome) => outcomes.push(`publish:${outcome}`),
          queueDepth: () => undefined,
          flush: async (_input, run) => run(),
        },
      },
    });
    composition.publisher.enqueue(workspaceId, ["crawl.progress"]);
    await composition.shutdown();
    expect(outcomes).toEqual(expect.arrayContaining(["enqueue:accepted", "publish:accepted"]));
  });

  it("keeps enabled-but-rollout-disabled mode as no-op and closes transport only after drain", async () => {
    const order: string[] = [];
    const disabled = createRealtimePublisherComposition({ config: parseRealtimeConfig({ REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost" }) });
    expect(disabled.publisher.enqueue(workspaceId, ["crawl.progress"])).toMatchObject({ accepted: false, reason: "disabled" });
    const active = createRealtimePublisherComposition({
      config: parseRealtimeConfig({ REALTIME_MODE: "standalone", REALTIME_REDIS_URL: "redis://localhost", REALTIME_ROLLOUT_MODE: "default-on" }),
      transport: { publish: async () => { order.push("publish"); }, close: async () => { order.push("close"); } },
    });
    active.publisher.enqueue(workspaceId, ["crawl.progress"]);
    await active.shutdown();
    expect(order).toEqual(["publish", "close"]);
  });
});
