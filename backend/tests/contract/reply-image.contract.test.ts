import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_IMAGE_RENDITION_WIDTHS } from "../../src/modules/documents/contracts/index.js";
import sharp from "sharp";

import { ToolImageCapture, ToolImageLookup } from "../../src/modules/toolImages/composition.js";
import type { DocumentStorageLocator } from "../../src/modules/documents/contracts/storage.js";
import type { ToolImageObjectStore } from "../../src/modules/toolImages/domain.js";
import { InMemoryDocumentImages } from "../support/inMemoryDocumentImages.js";
import { InMemoryToolImageStore } from "../support/inMemoryToolImages.js";
import { createTestApp } from "../support/testApp.js";

const webpBytes = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 fake-image-bytes", "binary");

const servedImage = async () => {
  const documentImages = new InMemoryDocumentImages();
  const { app, dependencies } = createTestApp({ documentImages });
  const workspaceId = randomUUID();
  const imageId = randomUUID();
  const stored = await dependencies.documentStorage.upload({
    workspaceId,
    documentId: `document-image-${imageId}-w640`,
    filename: "image.webp",
    mimeType: "image/webp",
    buffer: webpBytes,
  });
  documentImages.add(workspaceId, {
    id: imageId,
    documentId: randomUUID(),
    chunkId: null,
    role: "primary",
    position: 0,
    alt: "",
    caption: null,
    width: 1280,
    height: 960,
    sha256: "sha",
  }, [{ width: 640, ...stored, generation: stored.generation ?? null }]);
  return { app, documentImages, imageId };
};

describe("public reply image route", () => {
  it("serves a stored image as WebP to any origin, without a session, for a short private while", async () => {
    const { app, imageId } = await servedImage();

    const response = await request(app).get(`/api/v1/public/reply-images/${imageId}/640`).expect(200);

    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(Buffer.from(response.body as Buffer).equals(webpBytes)).toBe(true);
  });

  it("serves every width a document image is re-encoded at", async () => {
    const documentImages = new InMemoryDocumentImages();
    const { app, dependencies } = createTestApp({ documentImages });
    const workspaceId = randomUUID();
    const imageId = randomUUID();
    const renditions = await Promise.all(DOCUMENT_IMAGE_RENDITION_WIDTHS.map(async (width) => {
      const stored = await dependencies.documentStorage.upload({
        workspaceId,
        documentId: `document-image-${imageId}-w${width}`,
        filename: "image.webp",
        mimeType: "image/webp",
        buffer: webpBytes,
      });
      return { width, ...stored, generation: stored.generation ?? null };
    }));
    documentImages.add(workspaceId, {
      id: imageId,
      documentId: randomUUID(),
      chunkId: null,
      role: "primary",
      position: 0,
      alt: "",
      caption: null,
      width: 1280,
      height: 960,
      sha256: "sha",
    }, renditions);

    for (const width of DOCUMENT_IMAGE_RENDITION_WIDTHS) {
      await request(app).get(`/api/v1/public/reply-images/${imageId}/${width}`).expect(200);
    }
  });

  it("answers a source past its budget of public reads with 429, before any lookup", async () => {
    const documentImages = new InMemoryDocumentImages();
    const findServable = vi.spyOn(documentImages, "findServable");
    const { app } = createTestApp({ documentImages, envOverrides: { PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS: 2 } });
    const imageUrl = `/api/v1/public/reply-images/${randomUUID()}/640`;

    await request(app).get(imageUrl).expect(404);
    await request(app).get(imageUrl).expect(404);
    await request(app).get(imageUrl).expect(429);

    expect(findServable).toHaveBeenCalledTimes(2);
  });

  it("answers 404 for an unknown image, a deleted one, and any width other than 320 or 640, spelled exactly", async () => {
    const { app, documentImages, imageId } = await servedImage();

    await request(app).get(`/api/v1/public/reply-images/${randomUUID()}/640`).expect(404);
    await request(app).get(`/api/v1/public/reply-images/${imageId}/320`).expect(404);
    await request(app).get(`/api/v1/public/reply-images/${imageId}/480`).expect(404);
    await request(app).get(`/api/v1/public/reply-images/${imageId}/640.webp`).expect(404);
    await request(app).get("/api/v1/public/reply-images/not-a-uuid/640").expect(404);
    for (const alias of ["0640", "6.4e2", "640.0", "+640", "%20640"]) {
      await request(app).get(`/api/v1/public/reply-images/${imageId}/${alias}`).expect(404);
    }

    documentImages.delete(imageId);
    await request(app).get(`/api/v1/public/reply-images/${imageId}/640`).expect(404);
  });

  it("copies a skill's card picture on demand when the browser asks first, and answers 404 once it has failed", async () => {
    const store = new InMemoryToolImageStore();
    const workspaceId = randomUUID();
    const waiting = randomUUID();
    const expired = randomUUID();
    store.add(waiting, workspaceId, "https://img.homes.example/photos/loft.jpg");
    store.add(expired, workspaceId, "https://img.homes.example/photos/expired.jpg");
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 80, b: 140 } } }).jpeg().toBuffer();
    const toolImages: { lookup?: ToolImageLookup } = {};
    const { app, dependencies } = createTestApp({ toolImages: { findServable: (input) => toolImages.lookup!.findServable(input) } });
    // Writes where the test app's storage puts it, so the route reads the copy the capture made.
    const storage = dependencies.documentStorage as typeof dependencies.documentStorage & DocumentStorageLocator;
    const objects: ToolImageObjectStore = {
      locate: ({ imageId, suffix }) => ({ ...storage.locate({ workspaceId, documentId: `tool-image-${imageId}-${suffix}` }), generation: null }),
      put: async ({ imageId, suffix, bytes, mimeType }) => {
        const stored = await storage.upload({ workspaceId, documentId: `tool-image-${imageId}-${suffix}`, filename: "image.webp", mimeType, buffer: bytes });
        return { sizeBytes: stored.sizeBytes };
      },
      remove: async () => {},
    };
    toolImages.lookup = new ToolImageLookup({
      store,
      capture: new ToolImageCapture({
        store,
        objects,
        fetchBytes: async (url) => url.includes("expired")
          ? { kind: "failed", reason: "http_status", status: 410 }
          : { kind: "fetched", bytes: photo, contentType: "image/jpeg", url },
        renditionWidths: DOCUMENT_IMAGE_RENDITION_WIDTHS,
      }),
    });

    const served = await request(app).get(`/api/v1/public/reply-images/${waiting}/640`).expect(200);
    expect(served.headers["content-type"]).toBe("image/webp");
    expect(Buffer.from(served.body as Buffer).subarray(8, 12).toString("latin1")).toBe("WEBP");
    await request(app).get(`/api/v1/public/reply-images/${waiting}/320`).expect(200);

    await request(app).get(`/api/v1/public/reply-images/${expired}/640`).expect(404);
    expect(store.rows.get(expired)?.status).toBe("failed");
    await request(app).get(`/api/v1/public/reply-images/${expired}/640`).expect(404);
  });
});
