import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ToolImageCaptureOutcome, ToolImageObjectStore } from "../../../src/modules/toolImages/domain.js";
import { ToolImageCapture } from "../../../src/modules/toolImages/services/toolImageCapture.js";
import { toolImageCaptureHandler } from "../../../src/modules/toolImages/services/toolImageJobs.js";
import { ToolImageLookup } from "../../../src/modules/toolImages/services/toolImageLookup.js";
import type { PublicBytesFetchResult, PublicBytesLimits } from "../../../src/shared/infra/http/publicBytesFetch.js";
import { NormalizationSlots } from "../../../src/shared/infra/images/normalizationSlots.js";
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

const harness = (fetchResult: Fetch, options: { concurrentCaptures?: number; now?: () => Date; decodeSlots?: NormalizationSlots } = {}) => {
  const store = new InMemoryToolImageStore();
  store.add(IMAGE_ID, WORKSPACE_ID, SIGNED_URL);
  const row = store.rows.get(IMAGE_ID)!;
  const objects = memoryObjects();
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const logger = { warn: vi.fn(), info: vi.fn() };
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
    decodeSlots: options.decodeSlots,
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

  it("copies a shop's small WebP thumbnail, opaque or with transparency, and serves it at every width", async () => {
    const opaque = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 240, g: 240, b: 240 } } }).webp({ quality: 80 }).toBuffer();
    const transparent = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 0.5 } } }).webp({ lossless: true }).toBuffer();

    for (const thumbnail of [opaque, transparent]) {
      const { row, capture } = harness(() => ({ kind: "fetched", bytes: thumbnail, contentType: "image/webp", url: SIGNED_URL }));

      expect(await capture.capture(IMAGE_ID, "on_demand")).toBe("stored");

      // Never enlarged: both widths keep the 300 px original, each under the width it is served at.
      expect(row.renditions.map((rendition) => [rendition.width, rendition.height])).toEqual([[320, 300], [640, 300]]);
    }
  });

  it("tells a picture that failed before from one that does not exist, without counting either as a capture", async () => {
    const failed = harness(() => ({ kind: "failed", reason: "blocked" }));
    await failed.capture.capture(IMAGE_ID, "job");
    failed.metrics.incrementCounter.mockClear();

    expect(await failed.capture.capture(IMAGE_ID, "on_demand")).toBe("failed");
    expect(await failed.capture.capture("44444444-4444-4444-8444-444444444444", "on_demand")).toBe("missing");

    expect(failed.fetchBytes).toHaveBeenCalledTimes(1);
    expect(failed.metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it("does not count asking for a picture already stored as a capture", async () => {
    const { capture, metrics, fetchBytes } = harness(() => fetched(photo));
    await capture.capture(IMAGE_ID, "job");
    metrics.incrementCounter.mockClear();

    expect(await capture.capture(IMAGE_ID, "on_demand")).toBe("stored");

    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  it("fails a claimed picture that has no address for good, counted and logged like any other failure", async () => {
    const { row, capture, metrics, logger, fetchBytes } = harness(() => fetched(photo));
    row.url = null;

    expect(await capture.capture(IMAGE_ID, "job")).toBe("source_missing");

    expect(row.status).toBe("failed");
    expect(row.reason).toBe("source_missing");
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_capture_total", expect.objectContaining({ labels: { trigger: "job", outcome: "source_missing" } }));
    expect(logger.info).toHaveBeenCalledWith({ imageId: IMAGE_ID, workspaceId: WORKSPACE_ID, trigger: "job", outcome: "source_missing" }, "tool_image_capture_failed");
  });

  it("hands a picture back as decoder_busy when the decoder stays full, distinct from a capture that found no turn", async () => {
    const decodeSlots = new NormalizationSlots(1, 50);
    let release: () => void = () => {};
    void decodeSlots.run(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const { row, capture, metrics } = harness(() => fetched(photo), { decodeSlots });

    expect(await capture.capture(IMAGE_ID, "job")).toBe("decoder_busy");

    expect(row.status).toBe("pending");
    expect(row.reason).toBe("decoder_busy");
    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_capture_total", expect.objectContaining({ labels: { trigger: "job", outcome: "decoder_busy" } }));
    release();
  });

  it("tells a second capture another one holds the picture", async () => {
    const held = harness(() => fetched(photo));
    held.row.status = "capturing";
    held.row.claimedAt = new Date();
    expect(await held.capture.capture(IMAGE_ID, "job")).toBe("held");
  });

  it("logs a picture that fails for good with its reason and ids, never its address", async () => {
    const { capture, logger } = harness(() => ({ kind: "failed", reason: "http_status", status: 403 }));

    await capture.capture(IMAGE_ID, "on_demand");

    expect(logger.info).toHaveBeenCalledWith(
      { imageId: IMAGE_ID, workspaceId: WORKSPACE_ID, trigger: "on_demand", outcome: "http_error" },
      "tool_image_capture_failed",
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("homes.example");
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


/** A capture of another picture that holds the process's only turn until `release` is called. */
const holdOnlyTurn = (setup: ReturnType<typeof harness>) => {
  const OTHER = "33333333-3333-4333-8333-333333333333";
  setup.store.add(OTHER, WORKSPACE_ID, "https://img.homes.example/other.jpg");
  return { holding: setup.capture.capture(OTHER, "job") };
};

/** A fetch that waits for `release` on the picture whose address names "other", and answers the rest at once. */
const gatedOnOther = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch: Fetch = async (url) => {
    if (url.includes("other")) await gate;
    return fetched(photo);
  };
  return { fetch, release: () => release() };
};

describe("bounded captures", () => {
  it("ends a capture at its deadline, whatever is still running, and hands the picture back", async () => {
    const { row, capture } = harness(async (_url, limits) => new Promise<PublicBytesFetchResult>((resolve) => {
      limits.signal?.addEventListener("abort", () => resolve({ kind: "failed", reason: "timeout" }), { once: true });
    }));
    const started = Date.now();

    expect(await capture.capture(IMAGE_ID, "on_demand", { deadlineMs: 1_300 })).toBe("timeout");

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(row.status).toBe("pending");
  });

  it("waits on demand for a capture turn to come free, and copies the picture within its deadline", async () => {
    const gated = gatedOnOther();
    const setup = harness(gated.fetch, { concurrentCaptures: 1 });
    const { holding } = holdOnlyTurn(setup);

    const waiting = setup.capture.capture(IMAGE_ID, "on_demand", { deadlineMs: 2_000 });
    setTimeout(gated.release, 100);

    expect(await waiting).toBe("stored");
    expect(await holding).toBe("stored");
  });

  it("answers busy on demand when no capture turn comes free while a second of its deadline is still left, without touching the picture", async () => {
    const gated = gatedOnOther();
    const setup = harness(gated.fetch, { concurrentCaptures: 1 });
    const { holding } = holdOnlyTurn(setup);
    const started = Date.now();

    expect(await setup.capture.capture(IMAGE_ID, "on_demand", { deadlineMs: 1_400 })).toBe("busy");

    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(1_000);
    expect(setup.row).toMatchObject({ status: "pending", reason: null });
    expect(setup.metrics.incrementCounter).toHaveBeenCalledWith("tool_image_capture_total", expect.objectContaining({ labels: { trigger: "on_demand", outcome: "busy" } }));
    gated.release();
    await holding;
  });

  it("answers busy without claiming the picture when less than a second of its deadline is left", async () => {
    const { row, capture, fetchBytes } = harness(() => fetched(photo));

    expect(await capture.capture(IMAGE_ID, "on_demand", { deadlineMs: 900 })).toBe("busy");

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "pending", reason: null, claimedAt: null });
  });

  it("answers from the picture's state without queueing behind busy turns when there is nothing to copy", async () => {
    const gated = gatedOnOther();
    const setup = harness(gated.fetch, { concurrentCaptures: 1 });
    const { holding } = holdOnlyTurn(setup);
    const [FAILED, HELD, STORED] = ["77777771-7777-4777-8777-777777777777", "77777772-7777-4777-8777-777777777777", "77777773-7777-4777-8777-777777777777"];
    for (const imageId of [FAILED, HELD, STORED]) setup.store.add(imageId, WORKSPACE_ID, "https://img.homes.example/x.jpg");
    Object.assign(setup.store.rows.get(FAILED)!, { status: "failed", url: null, reason: "http_error" });
    Object.assign(setup.store.rows.get(HELD)!, { status: "capturing", claimedAt: new Date() });
    Object.assign(setup.store.rows.get(STORED)!, { status: "stored", url: null });
    const started = Date.now();

    const results = await Promise.all([
      setup.capture.capture(FAILED, "on_demand"),
      setup.capture.capture(HELD, "on_demand"),
      setup.capture.capture(STORED, "on_demand"),
      setup.capture.capture("44444444-4444-4444-8444-444444444444", "on_demand"),
    ]);

    expect(results).toEqual(["failed", "held", "stored", "missing"]);
    expect(Date.now() - started).toBeLessThan(200);
    gated.release();
    await holding;
  });

  it("answers busy at once on demand past a few waiting requests per capture turn, and copies the ones that queued", async () => {
    const gated = gatedOnOther();
    const setup = harness(gated.fetch, { concurrentCaptures: 1 });
    const { holding } = holdOnlyTurn(setup);
    const queued = Array.from({ length: 4 }, (_, index) => `8888888${index}-8888-4888-8888-888888888888`);
    for (const imageId of [...queued, IMAGE_ID]) setup.store.add(imageId, WORKSPACE_ID, `https://img.homes.example/${imageId}.jpg`);
    const waiting = queued.map((imageId) => setup.capture.capture(imageId, "on_demand", { deadlineMs: 5_000 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();

    expect(await setup.capture.capture(IMAGE_ID, "on_demand", { deadlineMs: 5_000 })).toBe("busy");

    expect(Date.now() - started).toBeLessThan(200);
    expect(setup.row.status).toBe("pending");
    gated.release();
    expect(await Promise.all(waiting)).toEqual(queued.map(() => "stored"));
    await holding;
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

const missLogger = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

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

    const both = Promise.all([lookup.find({ imageId: IMAGE_ID, width: 320 }), lookup.find({ imageId: IMAGE_ID, width: 640 })]);
    release();
    const [small, large] = await both;

    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(small).toMatchObject({ kind: "found", object: { objectPath: expect.stringContaining(`${IMAGE_ID}-w320-`) } });
    expect(large).toMatchObject({ kind: "found", object: { bucket: "local", objectPath: expect.stringContaining(`${IMAGE_ID}-w640-`) } });
  });

  it("serves a stored picture without capturing, and misses a failed one for good", async () => {
    const stored = harness(() => fetched(photo));
    await stored.capture.capture(IMAGE_ID, "job");
    const spy = vi.spyOn(stored.capture, "capture");
    expect(await new ToolImageLookup({ store: stored.store, capture: stored.capture }).find({ imageId: IMAGE_ID, width: 640 })).toMatchObject({ kind: "found" });
    expect(spy).not.toHaveBeenCalled();

    const failed = harness(() => ({ kind: "failed", reason: "blocked" }));
    expect(await new ToolImageLookup({ store: failed.store, capture: failed.capture }).find({ imageId: IMAGE_ID, width: 640 }))
      .toEqual({ kind: "miss", reason: "failed", retryable: false });
  });

  it("waits within its budget for a capture another request holds", async () => {
    const { store, row, capture } = harness(() => fetched(photo));
    row.status = "capturing";
    row.claimedAt = new Date();
    const claim = { id: IMAGE_ID, workspaceId: WORKSPACE_ID, url: SIGNED_URL, claimedAt: row.claimedAt };
    setTimeout(() => {
      void store.markStored({ image: claim, width: 900, height: 600, sha256: "0".repeat(64), renditions: [{ bucket: "local", objectPath: "p", generation: null, width: 640, height: 427, sizeBytes: 10 }] });
    }, 300);

    const served = await new ToolImageLookup({ store, capture, budgetMs: 2_000 }).find({ imageId: IMAGE_ID, width: 640 });

    expect(served).toMatchObject({ kind: "found", object: { objectPath: "p" } });
  });

  it("serves every picture of a carousel asked for at once, more than the process captures at a time", async () => {
    // Four capture turns, as the process has by default, and six cards whose browser asks for all
    // six pictures before the job has copied any.
    const { store, capture } = harness(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return fetched(photo);
    });
    const cards = Array.from({ length: 6 }, (_, index) => `5555555${index}-5555-4555-8555-555555555555`);
    for (const imageId of cards) store.add(imageId, WORKSPACE_ID, `https://img.homes.example/photos/${imageId}.jpg`);
    const lookup = new ToolImageLookup({ store, capture });

    const served = await Promise.all(cards.map((imageId) => lookup.find({ imageId, width: 320 })));

    expect(served).toEqual(cards.map((imageId) => expect.objectContaining({ kind: "found", object: expect.objectContaining({ objectPath: expect.stringContaining(`${imageId}-w320-`) }) })));
  });

  it("records each miss of a route request with its reason and the image id only, and an unknown id at debug only", async () => {
    const gated = gatedOnOther();
    const setup = harness(async (url, limits) => (url.includes("expired") ? { kind: "failed", reason: "http_status", status: 410 } : gated.fetch(url, limits)), { concurrentCaptures: 1 });
    const EXPIRED = "66666666-6666-4666-8666-666666666666";
    setup.store.add(EXPIRED, WORKSPACE_ID, "https://img.homes.example/expired.jpg?signature=secret");
    const metrics = { incrementCounter: vi.fn() };
    const logger = missLogger();
    const lookup = new ToolImageLookup({ store: setup.store, capture: setup.capture, budgetMs: 1_300, metrics, logger });

    expect(await lookup.find({ imageId: EXPIRED, width: 640 }, { recordMiss: true })).toEqual({ kind: "miss", reason: "failed", retryable: false });
    expect(await lookup.find({ imageId: "44444444-4444-4444-8444-444444444444", width: 640 }, { recordMiss: true }))
      .toEqual({ kind: "miss", reason: "not_found", retryable: false });
    const { holding } = holdOnlyTurn(setup);
    expect(await lookup.find({ imageId: IMAGE_ID, width: 640 }, { recordMiss: true })).toEqual({ kind: "miss", reason: "busy", retryable: true });
    gated.release();
    await holding;

    expect(metrics.incrementCounter.mock.calls.map(([name, options]) => [name, options.labels])).toEqual([
      ["tool_image_miss_total", { reason: "failed" }],
      ["tool_image_miss_total", { reason: "not_found" }],
      ["tool_image_miss_total", { reason: "busy" }],
    ]);
    expect(logger.info.mock.calls).toEqual([[{ imageId: EXPIRED, reason: "failed", outcome: "http_error" }, "tool_image_miss"]]);
    expect(logger.debug.mock.calls).toEqual([[{ imageId: "44444444-4444-4444-8444-444444444444", reason: "not_found", outcome: "missing" }, "tool_image_miss"]]);
    expect(logger.warn.mock.calls).toEqual([[{ imageId: IMAGE_ID, reason: "busy", outcome: "busy" }, "tool_image_miss"]]);
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.debug.mock.calls])).not.toContain("homes.example");
  });

  it("records nothing for a caller that does not ask, such as a check before cards are sent", async () => {
    const { store, capture } = harness(() => ({ kind: "failed", reason: "blocked" }));
    const metrics = { incrementCounter: vi.fn() };
    const logger = missLogger();

    expect(await new ToolImageLookup({ store, capture, metrics, logger }).find({ imageId: IMAGE_ID, width: 640 })).toMatchObject({ kind: "miss", reason: "failed" });

    expect(metrics.incrementCounter).not.toHaveBeenCalled();
    expect([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.debug.mock.calls]).toEqual([]);
  });

  it("misses a picture whose capture outlives the request's budget as a timeout a later request may get past", async () => {
    const { store, capture } = harness(async (_url, limits) => new Promise<PublicBytesFetchResult>((resolve) => {
      limits.signal?.addEventListener("abort", () => resolve({ kind: "failed", reason: "timeout" }), { once: true });
    }));
    const metrics = { incrementCounter: vi.fn() };
    const logger = missLogger();

    expect(await new ToolImageLookup({ store, capture, budgetMs: 1_300, metrics, logger }).find({ imageId: IMAGE_ID, width: 640 }, { recordMiss: true }))
      .toEqual({ kind: "miss", reason: "timeout", retryable: true });

    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_miss_total", expect.objectContaining({ labels: { reason: "timeout" } }));
    expect(logger.warn).toHaveBeenCalledWith({ imageId: IMAGE_ID, reason: "timeout", outcome: "timeout" }, "tool_image_miss");
    expect(store.rows.get(IMAGE_ID)?.status).toBe("pending");
  });
});
