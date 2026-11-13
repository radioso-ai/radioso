import { describe, expect, it, vi } from "vitest";

import type { StoredDocumentImageRef } from "../../../src/modules/documents/contracts/index.js";
import { EvidenceImageAttacher, type EvidenceContext } from "../../../src/modules/retrieval/public.js";

const context = (documentId: string, chunkId: string, title: string, sourceUrl?: string): EvidenceContext => ({
  documentId,
  chunkId,
  title,
  ...(sourceUrl ? { metadata: { sourceUrl } } : {}),
});

const image = (overrides: Partial<StoredDocumentImageRef> & Pick<StoredDocumentImageRef, "id" | "documentId">): StoredDocumentImageRef => ({
  chunkId: null,
  role: "primary",
  position: 0,
  alt: "",
  caption: null,
  width: 1280,
  height: 960,
  sha256: `sha-${overrides.id}`,
  primaryDocumentCount: overrides.role === "inline" ? 0 : 1,
  ...overrides,
});

const attacherReading = (rows: StoredDocumentImageRef[]) => {
  const listStoredForEvidence = vi.fn(async () => rows);
  return { attacher: new EvidenceImageAttacher({ listStoredForEvidence }), listStoredForEvidence };
};

describe("EvidenceImageAttacher", () => {
  it("reads the evidence's documents and chunks once, scoped to the workspace", async () => {
    const { attacher, listStoredForEvidence } = attacherReading([]);

    await attacher.attach("workspace-1", [
      context("doc-1", "chunk-1", "Alpine Flowers"),
      context("doc-1", "chunk-2", "Alpine Flowers"),
      context("doc-2", "chunk-3", "Trail Maps"),
    ]);

    expect(listStoredForEvidence).toHaveBeenCalledTimes(1);
    expect(listStoredForEvidence).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      documentIds: ["doc-1", "doc-2"],
      chunkIds: ["chunk-1", "chunk-2", "chunk-3"],
    });
  });

  it("reads nothing for empty evidence", async () => {
    const { attacher, listStoredForEvidence } = attacherReading([]);

    await expect(attacher.attach("workspace-1", [])).resolves.toEqual([]);
    expect(listStoredForEvidence).not.toHaveBeenCalled();
  });

  it("attaches a document's primary image once, to its first evidence item, with the document's title and address", async () => {
    const { attacher } = attacherReading([
      image({ id: "img-cover", documentId: "doc-1", position: 0 }),
      image({ id: "img-cover-2", documentId: "doc-1", position: 1 }),
    ]);

    const items = await attacher.attach("workspace-1", [
      context("doc-1", "chunk-1", "Alpine Flowers", "https://shop.example/books/alpine-flowers"),
      context("doc-1", "chunk-2", "Alpine Flowers", "https://shop.example/books/alpine-flowers"),
    ]);

    expect(items).toEqual([{
      resultNumber: 1,
      documentId: "doc-1",
      documentTitle: "Alpine Flowers",
      sourceUrl: "https://shop.example/books/alpine-flowers",
      images: [{
        imageId: "img-cover",
        role: "primary",
        alt: "",
        caption: null,
        width: 1280,
        height: 960,
        sha256: "sha-img-cover",
      }],
    }]);
  });

  it("attaches inline images to the item whose chunk they are anchored to, primary first", async () => {
    const { attacher } = attacherReading([
      image({ id: "img-ridge", documentId: "doc-1", role: "inline", chunkId: "chunk-2", position: 2, alt: "Gentians on the ridge" }),
      image({ id: "img-cover", documentId: "doc-1", position: 0 }),
      image({ id: "img-pass", documentId: "doc-1", role: "inline", chunkId: "chunk-2", position: 1, caption: "The pass" }),
    ]);

    const items = await attacher.attach("workspace-1", [
      context("doc-1", "chunk-1", "Guest House"),
      context("doc-1", "chunk-2", "Guest House"),
    ]);

    expect(items.map((item) => ({ result: item.resultNumber, images: item.images.map((entry) => entry.imageId) }))).toEqual([
      { result: 1, images: ["img-cover"] },
      { result: 2, images: ["img-pass", "img-ridge"] },
    ]);
  });

  it("keeps at most three images per evidence item", async () => {
    const { attacher } = attacherReading([
      image({ id: "img-cover", documentId: "doc-1", position: 0 }),
      ...[1, 2, 3, 4].map((position) => image({ id: `img-${position}`, documentId: "doc-1", role: "inline", chunkId: "chunk-1", position })),
    ]);

    const [item] = await attacher.attach("workspace-1", [context("doc-1", "chunk-1", "Guest House")]);

    expect(item?.images.map((entry) => entry.imageId)).toEqual(["img-cover", "img-1", "img-2"]);
  });

  it("leaves out items without images and gives no address that is not http(s)", async () => {
    const { attacher } = attacherReading([image({ id: "img-cover", documentId: "doc-2" })]);

    const items = await attacher.attach("workspace-1", [
      context("doc-1", "chunk-1", "No Pictures"),
      { documentId: "doc-2", chunkId: "chunk-2", title: "Trail Maps", metadata: { sourceUrl: "javascript:alert(1)" } },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resultNumber: 2, documentId: "doc-2", documentTitle: "Trail Maps" });
    expect(items[0]).not.toHaveProperty("sourceUrl");
  });

  describe("a picture many documents call their own is a site banner, not a main picture", () => {
    it("does not show a primary image that more than five documents in the workspace share", async () => {
      const { attacher } = attacherReading([
        image({ id: "img-banner", documentId: "doc-1", sha256: "sha-banner", primaryDocumentCount: 6 }),
      ]);

      await expect(attacher.attach("workspace-1", [context("doc-1", "chunk-1", "Alpine Flowers")])).resolves.toEqual([]);
    });

    it("still shows one that five documents share", async () => {
      const { attacher } = attacherReading([
        image({ id: "img-series", documentId: "doc-1", sha256: "sha-series", primaryDocumentCount: 5 }),
      ]);

      const [item] = await attacher.attach("workspace-1", [context("doc-1", "chunk-1", "Alpine Flowers")]);

      expect(item?.images.map((entry) => entry.imageId)).toEqual(["img-series"]);
    });

    it("lets the document's next primary image stand as its main picture", async () => {
      const { attacher } = attacherReading([
        image({ id: "img-banner", documentId: "doc-1", position: 0, sha256: "sha-banner", primaryDocumentCount: 40 }),
        image({ id: "img-cover", documentId: "doc-1", position: 1, sha256: "sha-cover", primaryDocumentCount: 1 }),
      ]);

      const [item] = await attacher.attach("workspace-1", [context("doc-1", "chunk-1", "Alpine Flowers")]);

      expect(item?.images.map((entry) => entry.imageId)).toEqual(["img-cover"]);
    });

    it("never judges an inline image by it", async () => {
      const { attacher } = attacherReading([
        image({ id: "img-ridge", documentId: "doc-1", role: "inline", chunkId: "chunk-1", sha256: "sha-banner", primaryDocumentCount: 0 }),
      ]);

      const [item] = await attacher.attach("workspace-1", [context("doc-1", "chunk-1", "Guest House")]);

      expect(item?.images.map((entry) => entry.imageId)).toEqual(["img-ridge"]);
    });
  });
});
