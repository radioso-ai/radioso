import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { InMemoryDocumentImages } from "../support/inMemoryDocumentImages.js";
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
});
