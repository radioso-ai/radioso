import request from "supertest";
import { describe, expect, it } from "vitest";

import { InMemoryDocumentImageRows } from "../support/inMemoryDocumentImageRows.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("document detail images", () => {
  it("lists the pictures a document's content names, with the address of each stored copy", async () => {
    const documentImageRows = new InMemoryDocumentImageRows();
    const { app, repositories } = createTestApp({ documentImageRows });
    const session = await issueTestSession(app, "document-images@example.com");
    const created = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title: "A Field Guide to Alpine Flowers", content: "The guide walks through every meadow above the tree line." })
      .expect(202);
    const documentId = created.body.documentId as string;
    const workspaceId = repositories.documentRepository.items.get(documentId)?.workspaceId ?? "";
    const cover = documentImageRows.seed({
      workspaceId, documentId, sourceUrl: "https://cdn.shop.example/cover.jpg", role: "primary", position: 0, status: "stored",
      width: 1200, height: 900, sha256: "sha-cover",
      renditions: [{ width: 640, height: 480, bucket: "b", objectPath: "p", generation: null, sizeBytes: 10 }],
    });
    const pixel = documentImageRows.seed({
      workspaceId, documentId, sourceUrl: "https://track.shop.example/pixel.gif", role: "inline", position: 1, status: "skipped",
    });

    const response = await request(app).get(`/api/v1/document/${documentId}`).set(adminSessionHeaders(session)).expect(200);

    expect(response.body.images).toEqual([
      expect.objectContaining({
        id: cover.id,
        role: "primary",
        status: "stored",
        width: 1200,
        height: 900,
        sourceUrl: "https://cdn.shop.example/cover.jpg",
        src: expect.stringMatching(new RegExp(`/api/v1/public/reply-images/${cover.id}/640$`)),
        srcSet: expect.stringContaining(`/api/v1/public/reply-images/${cover.id}/320 320w`),
      }),
      { id: pixel.id, role: "inline", status: "skipped", alt: "", caption: null, width: null, height: null, sourceUrl: "https://track.shop.example/pixel.gif" },
    ]);
  });
});
