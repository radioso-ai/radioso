import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ClaimedToolImage,
  ToolImageCaptureOutcome,
  ToolImageClaim,
  ToolImageObject,
  ToolImageObjectStore,
  ToolImageRendition,
  ToolImageStore,
} from "../../../src/modules/toolImages/domain.js";
import { ToolImageCapture } from "../../../src/modules/toolImages/services/toolImageCapture.js";
import { StoredToolImageIntake } from "../../../src/modules/toolImages/services/toolImageIntake.js";
import { ToolImageLookup } from "../../../src/modules/toolImages/services/toolImageLookup.js";
import type { PublicBytesFetchResult } from "../../../src/shared/infra/http/publicBytesFetch.js";

const IMAGE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SIGNED_URL = "https://img.homes.example/photos/flat-1.jpg?signature=secret";

let photo: Buffer;
let tiny: Buffer;

beforeAll(async () => {
  photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 120, g: 160, b: 200 } } }).jpeg().toBuffer();
  tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
});

/** One row in memory, claimed and settled the way the Postgres store does. */
class MemoryStore implements ToolImageStore {
  status: "pending" | "capturing" | "stored" | "failed" = "pending";
  reason: string | null = null;
  renditions: ToolImageRendition[] = [];
  stored: { width: number; height: number; sha256: string } | null = null;

  constructor(private readonly source: ClaimedToolImage["source"]) {}

  async claim(imageId: string): Promise<ToolImageClaim> {
    if (imageId !== IMAGE_ID) return { kind: "missing" };
    if (this.status === "stored") return { kind: "stored" };
    if (this.status === "failed") return { kind: "failed" };
    if (this.status === "capturing") return { kind: "held" };
    this.status = "capturing";
    return { kind: "claimed", image: { id: IMAGE_ID, workspaceId: WORKSPACE_ID, source: this.source } };
  }

  async markStored(input: { width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }) {
    this.status = "stored";
    this.stored = { width: input.width, height: input.height, sha256: input.sha256 };
    this.renditions = [...input.renditions];
  }

  async markFailed(input: { reason: ToolImageCaptureOutcome }) {
    this.status = "failed";
    this.reason = input.reason;
  }

  async release(input: { reason: ToolImageCaptureOutcome }) {
    this.status = "pending";
    this.reason = input.reason;
  }

  async findRendition(input: { imageId: string; width: number }) {
    return this.status === "stored" && input.imageId === IMAGE_ID ? this.renditions.find((rendition) => rendition.width === input.width) ?? null : null;
  }

  async failPending() {}
}

const memoryObjects = () => {
  const written = new Map<string, Buffer>();
  const store: ToolImageObjectStore = {
    locate: ({ imageId, suffix }) => ({ bucket: "local", objectPath: `workspaces/${WORKSPACE_ID}/tool-images/${imageId}-${suffix}`, generation: null }),
    put: async ({ imageId, suffix, bytes }) => {
      written.set(`${imageId}-${suffix}`, bytes);
      return { sizeBytes: bytes.length };
    },
    get: async (object: ToolImageObject) => {
      const bytes = written.get(object.objectPath.split("/").pop()!);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    remove: async () => {},
  };
  return { written, store };
};

const fetched = (bytes: Buffer): PublicBytesFetchResult => ({ kind: "fetched", bytes, contentType: "image/jpeg", url: SIGNED_URL });

const harness = (fetchResult: () => PublicBytesFetchResult | Promise<PublicBytesFetchResult>, source: ClaimedToolImage["source"] = { kind: "url", url: SIGNED_URL }) => {
  const store = new MemoryStore(source);
  const objects = memoryObjects();
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const logger = { warn: vi.fn() };
  const fetchBytes = vi.fn(async () => fetchResult());
  const capture = new ToolImageCapture({ store, objects: objects.store, fetchBytes, renditionWidths: [320, 640], metrics, logger });
  return { store, objects, metrics, logger, fetchBytes, capture };
};

describe("tool image capture", () => {
  it("copies a picture into a WebP per served width and marks it stored", async () => {
    const { store, objects, metrics, capture, fetchBytes } = harness(() => fetched(photo));

    expect(await capture.capture(IMAGE_ID, "job")).toBe("stored");

    expect(fetchBytes).toHaveBeenCalledWith(SIGNED_URL, expect.objectContaining({ maxBytes: 8 * 1024 * 1024, accept: "image/*" }));
    expect(store.stored).toMatchObject({ width: 900, height: 600 });
    expect(store.renditions.map((rendition) => [rendition.width, rendition.height])).toEqual([[320, 213], [640, 427]]);
    expect([...objects.written.keys()]).toEqual([`${IMAGE_ID}-w320`, `${IMAGE_ID}-w640`]);
    expect(objects.written.get(`${IMAGE_ID}-w640`)!.subarray(8, 12).toString("latin1")).toBe("WEBP");
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
    const { store, capture, metrics } = harness(result);

    expect(await capture.capture(IMAGE_ID, "on_demand")).toBe(outcome);

    expect(store.status).toBe("failed");
    expect(store.reason).toBe(outcome);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("tool_image_capture_total", expect.objectContaining({ labels: { trigger: "on_demand", outcome } }));
  });

  it.each<[string, () => PublicBytesFetchResult, ToolImageCaptureOutcome]>([
    ["a timeout", () => ({ kind: "failed", reason: "timeout" }), "timeout"],
    ["a server error", () => ({ kind: "failed", reason: "http_status", status: 503 }), "unreachable"],
    ["a refused connection", () => ({ kind: "failed", reason: "unreachable" }), "unreachable"],
  ])("hands the picture back for a later attempt after %s", async (_name, result, outcome) => {
    const { store, capture } = harness(result);

    expect(await capture.capture(IMAGE_ID, "job")).toBe(outcome);

    expect(store.status).toBe("pending");
  });

  it("leaves a failed picture failed, and tells a second capture another one holds it", async () => {
    const failed = harness(() => ({ kind: "failed", reason: "blocked" }));
    await failed.capture.capture(IMAGE_ID, "job");
    expect(await failed.capture.capture(IMAGE_ID, "on_demand")).toBe("source_missing");
    expect(failed.fetchBytes).toHaveBeenCalledTimes(1);

    const held = harness(() => fetched(photo));
    held.store.status = "capturing";
    expect(await held.capture.capture(IMAGE_ID, "job")).toBe("held");
  });

  it("copies the bytes a skill returned from their source object", async () => {
    const { store, objects, capture, fetchBytes } = harness(() => fetched(photo), {
      kind: "inline",
      object: { bucket: "local", objectPath: `workspaces/${WORKSPACE_ID}/tool-images/${IMAGE_ID}-source`, generation: null },
    });
    objects.written.set(`${IMAGE_ID}-source`, photo);

    expect(await capture.capture(IMAGE_ID, "job")).toBe("stored");

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(store.status).toBe("stored");
  });

  it("logs ids only when storage fails, and hands the picture back", async () => {
    const { store, objects, logger, capture } = harness(() => fetched(photo));
    objects.store.put = async () => {
      throw new Error(`upload to ${SIGNED_URL} failed`);
    };

    expect(await capture.capture(IMAGE_ID, "job")).toBe("unreachable");

    expect(store.status).toBe("pending");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("homes.example");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ imageId: IMAGE_ID, workspaceId: WORKSPACE_ID }), "tool_image_capture_errored");
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
    expect(small?.objectPath).toContain(`${IMAGE_ID}-w320`);
    expect(large).toMatchObject({ bucket: "local", objectPath: expect.stringContaining(`${IMAGE_ID}-w640`) });
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
    const { store, capture } = harness(() => fetched(photo));
    store.status = "capturing";
    setTimeout(() => {
      void store.markStored({ width: 900, height: 600, sha256: "0".repeat(64), renditions: [{ bucket: "local", objectPath: "p", generation: null, width: 640, height: 427, sizeBytes: 10 }] });
    }, 300);

    const served = await new ToolImageLookup({ store, capture, budgetMs: 2_000 }).findServable({ imageId: IMAGE_ID, width: 640 });

    expect(served?.objectPath).toBe("p");
  });
});

describe("tool image intake", () => {
  const intake = (rows = { insertInline: vi.fn(async () => {}) }) => {
    const objects = memoryObjects();
    return { rows, objects, intake: new StoredToolImageIntake({ objects: objects.store, rows, newImageId: () => IMAGE_ID }) };
  };

  it("keeps a raster picture's bytes untouched and records an unbound row", async () => {
    const { rows, objects, intake: subject } = intake();

    expect(await subject.accept({ workspaceId: WORKSPACE_ID, conversationId: "c-1", bytes: photo })).toEqual({ kept: true, imageId: IMAGE_ID });
    expect(objects.written.get(`${IMAGE_ID}-source`)).toBe(photo);
    expect(rows.insertInline).toHaveBeenCalledWith(expect.objectContaining({ id: IMAGE_ID, conversationId: "c-1" }));
  });

  it("refuses an SVG and anything past the size cap", async () => {
    const { intake: subject, objects } = intake();

    expect(await subject.accept({ workspaceId: WORKSPACE_ID, conversationId: "c-1", bytes: Buffer.from("<svg></svg>") })).toEqual({ kept: false, reason: "unsupported_type" });
    expect(await subject.accept({ workspaceId: WORKSPACE_ID, conversationId: "c-1", bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).toEqual({ kept: false, reason: "too_large" });
    expect(objects.written.size).toBe(0);
  });
});
