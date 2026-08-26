import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInvalidationEnvelope } from "@radioso/workspace-invalidation-contract";
import { BoundedInvalidationProducer } from "../../../src/modules/realtime/application/boundedInvalidationProducer.js";

const first = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const second = "b4f5c8d3-d241-4f8f-a4db-3df5b88da44c";

describe("bounded invalidation producer", () => {
  it("enqueues synchronously, merges workspace kinds, and performs no broker work on mutations", async () => {
    const publish = vi.fn<(event: WorkspaceInvalidationEnvelope) => Promise<void>>().mockResolvedValue();
    const producer = new BoundedInvalidationProducer({ transport: { publish }, options: { cadenceMs: 1 } });
    expect(producer.enqueue(first, ["crawl.progress"])).toMatchObject({ accepted: true });
    expect(producer.enqueue(first, ["crawl.status_changed"])).toMatchObject({ accepted: true, coalesced: true });
    expect(publish).not.toHaveBeenCalled();
    await producer.flushNow();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: first, changeKinds: expect.arrayContaining(["crawl.progress", "crawl.status_changed"]) }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await producer.shutdown();
  });

  it("bounds distinct workspaces while allowing an existing workspace to coalesce", () => {
    const producer = new BoundedInvalidationProducer({ transport: { publish: async () => undefined }, options: { maxPendingWorkspaces: 1, flushBatchSize: 1, publishConcurrency: 1 } });
    expect(producer.enqueue(first, ["crawl.progress"])).toMatchObject({ accepted: true });
    expect(producer.enqueue(second, ["crawl.progress"])).toMatchObject({ accepted: false, reason: "capacity" });
    expect(producer.enqueue(first, ["crawl.status_changed"])).toMatchObject({ accepted: true, coalesced: true });
  });

  it("reports aggregate coalesce, capacity-drop, and publish-failure outcomes without payload labels", async () => {
    const outcomes: string[] = [];
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(undefined);
    const producer = new BoundedInvalidationProducer({
      transport: { publish },
      telemetry: {
        enqueue: (outcome) => outcomes.push(outcome),
        publish: (outcome) => outcomes.push(outcome),
        queueDepth: () => undefined,
        flush: async (_input, run) => {
          outcomes.push("flush");
          return run();
        },
      },
      options: { maxPendingWorkspaces: 1, flushBatchSize: 1, publishConcurrency: 1 },
    });
    producer.enqueue(first, ["crawl.progress"]);
    producer.enqueue(first, ["crawl.status_changed"]);
    producer.enqueue(second, ["crawl.progress"]);
    await producer.flushNow();
    expect(outcomes).toEqual(expect.arrayContaining(["accepted", "coalesced", "dropped", "failed", "flush"]));
    await producer.shutdown();
  });

  it("retries a failed publish with both the original and concurrently enqueued kinds", async () => {
    let rejectFirstPublish!: (reason: Error) => void;
    const firstPublish = new Promise<void>((_resolve, reject) => {
      rejectFirstPublish = reject;
    });
    const publish = vi.fn()
      .mockImplementationOnce(() => firstPublish)
      .mockResolvedValue(undefined);
    const producer = new BoundedInvalidationProducer({
      transport: { publish },
      options: { cadenceMs: 1 },
    });

    producer.enqueue(first, ["crawl.progress"]);
    const failedFlush = producer.flushNow();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    producer.enqueue(first, ["crawl.status_changed"]);
    rejectFirstPublish(new Error("temporarily unavailable"));
    await failedFlush;

    expect(producer.debugState().pendingWorkspaces).toBe(1);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: first,
        changeKinds: expect.arrayContaining(["crawl.progress", "crawl.status_changed"]),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await producer.shutdown();
  });

  it("uses one scheduler and fair workspace order with bounded concurrency", async () => {
    const seen: string[] = [];
    const producer = new BoundedInvalidationProducer({ transport: { publish: async (event) => { seen.push(event.workspaceId); } }, options: { cadenceMs: 1, flushBatchSize: 2, publishConcurrency: 1 } });
    producer.enqueue(first, ["crawl.progress"]);
    producer.enqueue(second, ["crawl.progress"]);
    await producer.flushNow();
    expect(seen).toEqual([first, second]);
    expect(producer.debugState().scheduledTimers).toBeLessThanOrEqual(1);
  });

  it("keeps a bounded cooldown so normal scheduling cannot bypass the workspace cadence", async () => {
    let now = 0;
    const publish = vi.fn().mockResolvedValue(undefined);
    const producer = new BoundedInvalidationProducer({ transport: { publish }, now: () => now, options: { cadenceMs: 100 } });
    producer.enqueue(first, ["crawl.progress"]);
    await producer.flushNow();
    producer.enqueue(first, ["crawl.progress"]);
    await producer.flushNow({ force: false });
    expect(publish).toHaveBeenCalledTimes(1);
    now = 100;
    await producer.flushNow({ force: false });
    expect(publish).toHaveBeenCalledTimes(2);
    await producer.shutdown();
  });

  it("reports a duplicate kind as coalesced and bounds shutdown behind publish timeout", async () => {
    const producer = new BoundedInvalidationProducer({
      transport: { publish: async () => new Promise<void>(() => undefined) },
      options: { publishTimeoutMs: 5, shutdownTimeoutMs: 10 },
    });
    expect(producer.enqueue(first, ["crawl.progress"])).toMatchObject({ accepted: true, coalesced: false });
    expect(producer.enqueue(first, ["crawl.progress"])).toMatchObject({ accepted: true, coalesced: true });
    await expect(producer.shutdown()).resolves.toBeUndefined();
  });

  it("labels empty input as invalid instead of capacity", () => {
    const producer = new BoundedInvalidationProducer({ transport: { publish: async () => undefined } });
    expect(producer.enqueue(first, [])).toEqual({ accepted: false, reason: "invalid" });
  });

  it("rejects invalid UUIDs and invalid runtime kinds before testing capacity", () => {
    const producer = new BoundedInvalidationProducer({ transport: { publish: async () => undefined }, options: { maxPendingWorkspaces: 1, flushBatchSize: 1, publishConcurrency: 1 } });
    expect(producer.enqueue("not-a-uuid", ["crawl.progress"])).toMatchObject({ accepted: false, reason: "invalid" });
    expect(producer.enqueue(first, ["future.kind" as never])).toMatchObject({ accepted: false, reason: "invalid" });
  });

  it("validates producer option relationships", () => {
    expect(() => new BoundedInvalidationProducer({ transport: { publish: async () => undefined }, options: { maxPendingWorkspaces: 1, flushBatchSize: 2 } })).toThrow(/capacity/i);
    expect(() => new BoundedInvalidationProducer({ transport: { publish: async () => undefined }, options: { publishConcurrency: 0 } })).toThrow(/positive/i);
  });

  it("drains more than one batch and shares one idempotent shutdown operation", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const producer = new BoundedInvalidationProducer({ transport: { publish }, options: { maxPendingWorkspaces: 3, flushBatchSize: 1, publishConcurrency: 1 } });
    producer.enqueue(first, ["crawl.progress"]);
    producer.enqueue(second, ["crawl.progress"]);
    producer.enqueue("5d7293c8-d241-4f8f-a4db-3df5b88da44c", ["crawl.progress"]);
    const left = producer.shutdown();
    expect(producer.shutdown()).toBe(left);
    await left;
    expect(publish).toHaveBeenCalledTimes(3);
    expect(producer.debugState().pendingWorkspaces).toBe(0);
  });

  it("aborts a deferred publish at the shutdown deadline and starts no later work", async () => {
    const signals: AbortSignal[] = [];
    const publish = vi.fn((_event: WorkspaceInvalidationEnvelope, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return new Promise<void>(() => undefined);
    });
    const producer = new BoundedInvalidationProducer({
      transport: { publish },
      options: { publishTimeoutMs: 1_000, shutdownTimeoutMs: 5 },
    });
    producer.enqueue(first, ["crawl.progress"]);

    await producer.shutdown();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(producer.enqueue(second, ["crawl.progress"])).toEqual({ accepted: false, reason: "shutdown" });
    await producer.flushNow();
    expect(publish).toHaveBeenCalledOnce();
    expect(producer.debugState()).toEqual({ pendingWorkspaces: 0, scheduledTimers: 0 });
  });

  it("expires idle cooldown records so completed work does not become an unbounded workspace cache", async () => {
    let now = 0;
    const producer = new BoundedInvalidationProducer({ transport: { publish: async () => undefined }, now: () => now, options: { maxPendingWorkspaces: 1, flushBatchSize: 1, publishConcurrency: 1, cadenceMs: 10 } });
    producer.enqueue(first, ["crawl.progress"]);
    await producer.flushNow();
    expect(producer.enqueue(second, ["crawl.progress"])).toMatchObject({ accepted: false, reason: "capacity" });
    now = 10;
    await producer.flushNow({ force: false });
    expect(producer.enqueue(second, ["crawl.progress"])).toMatchObject({ accepted: true });
    await producer.shutdown();
  });
});
