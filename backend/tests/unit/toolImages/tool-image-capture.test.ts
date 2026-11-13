import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ToolImageCaptureOutcome, ToolImageObjectStore } from "../../../src/modules/toolImages/domain.js";
import { ToolImageCapture } from "../../../src/modules/toolImages/services/toolImageCapture.js";
import { toolImageCaptureHandler } from "../../../src/modules/toolImages/services/toolImageJobs.js";
import { ToolImageLookup } from "../../../src/modules/toolImages/services/toolImageLookup.js";
import type { PublicBytesFetchResult, PublicBytesLimits } from "../../../src/shared/infra/http/publicBytesFetch.js";
import { InMemoryToolImageStore } from "../../support/inMemoryToolImages.js";

const IMAGE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SIGNED_URL = "https://img.homes.example/photos/flat-1.jpg?signature=secret";

let photo: Buffer;
let tiny: Buffer;

beforeAll(async () => {
  photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 120, g: 160, b: 200 } } }).jpeg().toBuffer();
  tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
});

/** Storage in memory: every written object, by its path, and the paths deleted. */
const memoryObjects = () => {
  const written = new Map<string, Buffer>();
  const store: ToolImageObjectStore = {
    locate: ({ imageId, suffix }) => ({ bucket: "local", objectPath: `workspaces/${WORKSPACE_ID}/tool-images/${imageId}-${suffix}`, generation: null }),
    put: async ({ imageId, suffix, bytes }) => {
      written.set(`workspaces/${WORKSPACE_ID}/tool-images/${imageId}-${suffix}`, bytes);
      return { sizeBytes: bytes.length };
    },
    remove: async (object) => {
      written.delete(object.objectPath);
    },
  };
  return { written, store };
};

const fetched = (bytes: Buffer): PublicBytesFetchResult => ({ kind: "fetched", bytes, contentType: "image/jpeg", url: SIGNED_URL });

type Fetch = (url: string, limits: PublicBytesLimits) => PublicBytesFetchResult | Promise<PublicBytesFetchResult>;

const harness = (fetchResult: Fetch, options: { concurrentCaptures?: number; now?: () => Date } = {}) => {
  const store = new InMemoryToolImageStore();
  store.add(IMAGE_ID, WORKSPACE_ID, SIGNED_URL);
  const row = store.rows.get(IMAGE_ID)!;
  const objects = memoryObjects();
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const logger = { warn: vi.fn() };
  const fetchBytes = vi.fn(async (url: string, limits: PublicBytesLimits) => fetchResult(url, limits));
  let tags = 0;
  const capture = new ToolImageCapture({
    store,
    objects: objects.store,
    fetchBytes,
    renditionWidths: [320, 640],
    metrics,
    logger,
    concurrentCaptures: options.concurrentCaptures,
    now: options.now,
    newCaptureTag: () => `${String(++tags).padStart(12, "0")}`,
  });
  return { store, row, objects, metrics, logger, fetchBytes, capture };
};

describe("tool image capture", () => {
  it("copies a picture into a WebP per served width, under names of its own, and marks it stored", async () => {
    const { row, objects, metrics, capture, fetchBytes } = harness(() => fetched(photo));

    expect(await capture.capture(IMAGE_ID, "job")).toBe("stored");

    expect(fetchBytes).toHaveBeenCalledWith(SIGNED_URL, expect.objectContaining({ maxBytes: 8 * 1024 * 1024, accept: "image/*", signal: expect.any(AbortSignal) }));
    expect(row.stored).toMatchObject({ width: 900, height: 600 });
    expect(row.url).toBeNull();
    expect(row.renditions.map((rendition) => [rendition.width, rendition.height])).toEqual([[320, 213], [640, 427]]);
    expect([...objects.written.keys()]).toEqual([
      `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-w320-000000000001`,
      `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-w640-000000000001`,
    ]);
    expect(objects.written.get(row.renditions[1].objectPath)!.subarray(8, 12).toString("latin1")).toBe("WEBP");
    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_capture_total", expect.objectContaining({ labels: { trigger: "job", outcome: "stored" } }));
    expect(metrics.observeHistogram).toHaveBeenCalledWith("tool_image_capture_duration_seconds", expect.objectContaining({ labels: { trigger: "job" } }));
  });

  it.each<[string, () => PublicBytesFetchResult, ToolImageCaptureOutcome]>([
    ["a private address", () => ({ kind: "failed", reason: "blocked" }), "blocked_address"],
    ["an expired link", () => ({ kind: "failed", reason: "http_status", status: 403 }), "http_error"],
    ["a body past the cap", () => ({ kind: "failed", reason: "too_large" }), "too_large"],
    ["a page, not a picture", () => fetched(Buffer.from("<html><body>listing</body></html>")), "unsupported_type"],
    ["an SVG", () => fetched(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), "unsupported_type"],
    ["a tracking pixel", () => fetched(tiny), "too_small"],
    ["bytes that do not decode", () => fetched(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64)])), "unsupported_type"],
  ])("fails %s for good, with its reason", async (_name, result, outcome) => {
    const { row, capture, metrics } = harness(result);

    expect(await capture.capture(IMAGE_ID, "on_demand")).toBe(outcome);

    expect(row.status).toBe("failed");
    expect(row.reason).toBe(outcome);
    expect(row.url).toBeNull();
    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_capture_total", expect.objectContaining({ labels: { trigger: "on_demand", outcome } }));
  });

  it.each<[string, () => PublicBytesFetchResult, ToolImageCaptureOutcome]>([
    ["a timeout", () => ({ kind: "failed", reason: "timeout" }), "timeout"],
    ["a server error", () => ({ kind: "failed", reason: "http_status", status: 503 }), "unreachable"],
    ["a refused connection", () => ({ kind: "failed", reason: "unreachable" }), "unreachable"],
  ])("hands the picture back for a later attempt after %s", async (_name, result, outcome) => {
    const { row, capture } = harness(result);

    expect(await capture.capture(IMAGE_ID, "job")).toBe(outcome);

    expect(row.status).toBe("pending");
    expect(row.url).toBe(SIGNED_URL);
  });

  it("leaves a failed picture failed, and tells a second capture another one holds it", async () => {
    const failed = harness(() => ({ kind: "failed", reason: "blocked" }));
    await failed.capture.capture(IMAGE_ID, "job");
    expect(await failed.capture.capture(IMAGE_ID, "on_demand")).toBe("source_missing");
    expect(failed.fetchBytes).toHaveBeenCalledTimes(1);

    const held = harness(() => fetched(photo));
    held.row.status = "capturing";
    held.row.claimedAt = new Date();
    expect(await held.capture.capture(IMAGE_ID, "job")).toBe("held");
  });

  it("logs ids only when storage fails, hands the picture back, and hands off what it wrote", async () => {
    const { row, store, objects, logger, capture } = harness(() => fetched(photo));
    let puts = 0;
    const put = objects.store.put;
    objects.store.put = async (input) => {
      if (++puts === 2) throw new Error(`upload to ${SIGNED_URL} failed`);
      return put(input);
    };

    expect(await capture.capture(IMAGE_ID, "job")).toBe("unreachable");

    expect(row.status).toBe("pending");
    expect(store.handedOff.map((object) => object.objectPath)).toEqual([
      `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-w320-000000000001`,
      `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-w640-000000000001`,
    ]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("homes.example");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ imageId: IMAGE_ID, workspaceId: WORKSPACE_ID }), "tool_image_capture_errored");
  });
});

describe("a capture that outlives its claim", () => {
  it("changes nothing when another capture took the picture over and stored it, and keeps the other's copies", async () => {
    let clock = Date.parse("2026-11-13T10:00:00.000Z");
    let releaseSlow: () => void = () => {};
    const slowFetch = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let calls = 0;
    const { row, store, objects, capture } = harness(async () => {
      calls += 1;
      if (calls === 1) await slowFetch;
      return fetched(photo);
    }, { now: () => new Date(clock), concurrentCaptures: 4 });

    // The first capture claims the picture and stalls; past the 30 s claim timeout a second takes over.
    const slow = capture.capture(IMAGE_ID, "job", { deadlineMs: 60_000 });
    await vi.waitFor(() => expect(calls).toBe(1));
    clock += 31_000;
    expect(await capture.capture(IMAGE_ID, "job")).toBe("stored");
    const winner = row.renditions.map((rendition) => rendition.objectPath);

    releaseSlow();
    expect(await slow).toBe("held");

    expect(row.status).toBe("stored");
    expect(row.renditions.map((rendition) => rendition.objectPath)).toEqual(winner);
    for (const path of winner) expect(objects.written.has(path)).toBe(true);
    // The loser's own copies, under its own tag, are the only ones handed to the deletion job.
    expect(store.handedOff.map((object) => object.objectPath).sort()).toEqual([
      `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-w320-000000000002`,
      `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-w640-000000000002`,
    ]);
    expect(winner.every((path) => path.endsWith("-000000000001"))).toBe(true);
  });

  it("does not hand back a picture another capture now holds", async () => {
    let clock = Date.parse("2026-11-13T10:00:00.000Z");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { row, store, capture } = harness(async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return { kind: "failed", reason: "timeout" };
      }
      return new Promise<PublicBytesFetchResult>(() => undefined);
    }, { now: () => new Date(clock) });

    const stale = capture.capture(IMAGE_ID, "job", { deadlineMs: 60_000 });
    await vi.waitFor(() => expect(calls).toBe(1));
    clock += 31_000;
    const takeover = await store.claim(IMAGE_ID, new Date(clock));
    expect(takeover.kind).toBe("claimed");

    release();
    await stale;

    // The stale capture's release matched nothing: the live claim still holds the picture.
    expect(row.status).toBe("capturing");
    expect(row.claimedAt?.getTime()).toBe(clock);
  });
});

describe("bounded captures", () => {
  it("ends a capture at its deadline, whatever is still running, and hands the picture back", async () => {
    const { row, capture } = harness(async (_url, limits) => new Promise<PublicBytesFetchResult>((resolve) => {
      limits.signal?.addEventListener("abort", () => resolve({ kind: "failed", reason: "timeout" }), { once: true });
    }));
    const started = Date.now();

    expect(await capture.capture(IMAGE_ID, "on_demand", { deadlineMs: 150 })).toBe("timeout");

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(row.status).toBe("pending");
  });

  it("answers busy at once on demand when every capture turn is taken, without touching the picture", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, capture } = harness(async () => {
      await gate;
      return fetched(photo);
    }, { concurrentCaptures: 1 });
    const OTHER = "33333333-3333-4333-8333-333333333333";
    store.add(OTHER, WORKSPACE_ID, "https://img.homes.example/other.jpg");

    const first = capture.capture(OTHER, "job");
    const started = Date.now();
    expect(await capture.capture(IMAGE_ID, "on_demand")).toBe("busy");
    expect(Date.now() - started).toBeLessThan(500);
    expect(store.rows.get(IMAGE_ID)?.status).toBe("pending");

    release();
    expect(await first).toBe("stored");
  });

  it("stops a job run whose own signal aborted, leaving the rest for the next run", async () => {
    const { store, capture } = harness(() => fetched(photo));
    const controller = new AbortController();
    controller.abort();
    const handler = toolImageCaptureHandler({ capture, store });

    await expect(handler.run({ imageIds: [IMAGE_ID] }, { jobId: "job-1", attempt: 1, signal: controller.signal })).rejects.toThrow("tool_image_capture_retry");
    expect(store.rows.get(IMAGE_ID)?.status).toBe("pending");
  });
});

describe("tool image lookup", () => {
  it("captures a waiting picture once, however many widths are asked for at the same time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { capture, fetchBytes, store } = harness(async () => {
      await gate;
      return fetched(photo);
    });
    const lookup = new ToolImageLookup({ store, capture });

    const both = Promise.all([lookup.findServable({ imageId: IMAGE_ID, width: 320 }), lookup.findServable({ imageId: IMAGE_ID, width: 640 })]);
    release();
    const [small, large] = await both;

    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(small?.objectPath).toContain(`${IMAGE_ID}-w320-`);
    expect(large).toMatchObject({ bucket: "local", objectPath: expect.stringContaining(`${IMAGE_ID}-w640-`) });
  });

  it("serves a stored picture without capturing, and misses a failed one", async () => {
    const stored = harness(() => fetched(photo));
    await stored.capture.capture(IMAGE_ID, "job");
    const spy = vi.spyOn(stored.capture, "capture");
    expect(await new ToolImageLookup({ store: stored.store, capture: stored.capture }).findServable({ imageId: IMAGE_ID, width: 640 })).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();

    const failed = harness(() => ({ kind: "failed", reason: "blocked" }));
    expect(await new ToolImageLookup({ store: failed.store, capture: failed.capture }).findServable({ imageId: IMAGE_ID, width: 640 })).toBeNull();
  });

  it("waits within its budget for a capture another request holds", async () => {
    const { store, row, capture } = harness(() => fetched(photo));
    row.status = "capturing";
    row.claimedAt = new Date();
    const claim = { id: IMAGE_ID, workspaceId: WORKSPACE_ID, url: SIGNED_URL, claimedAt: row.claimedAt };
    setTimeout(() => {
      void store.markStored({ image: claim, width: 900, height: 600, sha256: "0".repeat(64), renditions: [{ bucket: "local", objectPath: "p", generation: null, width: 640, height: 427, sizeBytes: 10 }] });
    }, 300);

    const served = await new ToolImageLookup({ store, capture, budgetMs: 2_000 }).findServable({ imageId: IMAGE_ID, width: 640 });

    expect(served?.objectPath).toBe("p");
  });

  it("misses at once while the process runs as many captures as it allows", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, capture } = harness(async () => {
      await gate;
      return fetched(photo);
    }, { concurrentCaptures: 1 });
    const OTHER = "33333333-3333-4333-8333-333333333333";
    store.add(OTHER, WORKSPACE_ID, "https://img.homes.example/other.jpg");
    const busy = capture.capture(OTHER, "job");

    const started = Date.now();
    expect(await new ToolImageLookup({ store, capture }).findServable({ imageId: IMAGE_ID, width: 640 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);

    release();
    await busy;
  });
});
