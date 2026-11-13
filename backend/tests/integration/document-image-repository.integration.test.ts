import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { DocumentImageRepository } from "../../src/modules/documents/composition.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const rendition = (width: number) => ({
  width,
  height: width,
  bucket: "local",
  objectPath: `workspaces/w/document-image-${width}`,
  generation: null,
  sizeBytes: 1000 + width,
});

describeIntegration("DocumentImageRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new DocumentImageRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  let documentId: string;
  let otherDocumentId: string;
  const chunkId = randomUUID();

  const insertDocument = async (id: string, workspace: string) => {
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, revision, metadata)
       VALUES ($1, $2, 'Field Guide', 'content', 'content', 'ready', 1, '{}'::jsonb)`,
      [id, workspace],
    );
  };

  const insertImage = async (input: {
    documentId: string;
    workspaceId: string;
    role: "primary" | "inline";
    status: "pending" | "stored";
    position: number;
    chunkId?: string | null;
    sourceUrl: string;
  }): Promise<string> => {
    const stored = input.status === "stored";
    const rows = await database.query<{ id: string }>(
      `INSERT INTO document_images
         (workspace_id, document_id, chunk_id, role, status, position, source_url, alt, caption, width, height, sha256, renditions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Gentians on the ridge', NULL, $8, $9, $10, $11::jsonb)
       RETURNING id`,
      [
        input.workspaceId,
        input.documentId,
        input.chunkId ?? null,
        input.role,
        input.status,
        input.position,
        input.sourceUrl,
        stored ? 1280 : null,
        stored ? 960 : null,
        stored ? `sha-${input.sourceUrl}` : null,
        JSON.stringify(stored ? [rendition(320), rendition(640)] : []),
      ],
    );
    return rows[0].id;
  };

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Document Images Co",
      `document-images-${accountId}@example.com`,
      "hash",
    ]);
    for (const id of [workspaceId, otherWorkspaceId]) {
      await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
        id,
        accountId,
        "Document Images WS",
        `route-${id}`,
      ]);
    }
  });

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = ANY($1)", [[workspaceId, otherWorkspaceId]]);
    // Deleted documents release their images; the sweep is not under test here.
    await database.query("DELETE FROM document_images WHERE workspace_id = ANY($1)", [[workspaceId, otherWorkspaceId]]);
    documentId = randomUUID();
    otherDocumentId = randomUUID();
    await insertDocument(documentId, workspaceId);
    await insertDocument(otherDocumentId, otherWorkspaceId);
  });

  afterAll(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = ANY($1)", [[workspaceId, otherWorkspaceId]])
      .catch(() => undefined);
    await database.query("DELETE FROM document_images WHERE workspace_id = ANY($1)", [[workspaceId, otherWorkspaceId]])
      .catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reads only stored images: primaries of the documents and inline images of the chunks", async () => {
    const primary = await insertImage({ documentId, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://shop.example/cover.jpg" });
    const inline = await insertImage({ documentId, workspaceId, role: "inline", status: "stored", position: 1, chunkId, sourceUrl: "https://shop.example/ridge.jpg" });
    await insertImage({ documentId, workspaceId, role: "inline", status: "pending", position: 2, chunkId, sourceUrl: "https://shop.example/pending.jpg" });
    await insertImage({ documentId, workspaceId, role: "inline", status: "stored", position: 3, chunkId: randomUUID(), sourceUrl: "https://shop.example/elsewhere.jpg" });

    const rows = await repository.listStoredForEvidence({ workspaceId, documentIds: [documentId], chunkIds: [chunkId], primaryDocumentCountLimit: 6 });

    expect(rows.map((row) => row.id).sort()).toEqual([primary, inline].sort());
    expect(rows.find((row) => row.id === primary)).toEqual({
      id: primary,
      documentId,
      chunkId: null,
      role: "primary",
      position: 0,
      alt: "Gentians on the ridge",
      caption: null,
      width: 1280,
      height: 960,
      sha256: "sha-https://shop.example/cover.jpg",
      primaryDocumentCount: 1,
    });
    expect(rows.find((row) => row.id === inline)?.chunkId).toBe(chunkId);
  });

  it("never reads another workspace's images", async () => {
    await insertImage({ documentId: otherDocumentId, workspaceId: otherWorkspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://other.example/cover.jpg" });

    const rows = await repository.listStoredForEvidence({ workspaceId, documentIds: [otherDocumentId], chunkIds: [], primaryDocumentCountLimit: 6 });

    expect(rows).toEqual([]);
  });

  it("asks nothing of the database for empty evidence", async () => {
    await expect(repository.listStoredForEvidence({ workspaceId, documentIds: [], chunkIds: [], primaryDocumentCountLimit: 6 })).resolves.toEqual([]);
  });

  it("finds the stored rendition for a width, and nothing for a pending image or another width", async () => {
    const stored = await insertImage({ documentId, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://shop.example/cover.jpg" });
    const pending = await insertImage({ documentId, workspaceId, role: "inline", status: "pending", position: 1, chunkId, sourceUrl: "https://shop.example/pending.jpg" });

    await expect(repository.findServable({ imageId: stored, width: 640 })).resolves.toEqual({
      bucket: "local",
      objectPath: "workspaces/w/document-image-640",
      generation: null,
      sizeBytes: 1640,
    });
    await expect(repository.findServable({ imageId: stored, width: 480 })).resolves.toBeNull();
    await expect(repository.findServable({ imageId: pending, width: 640 })).resolves.toBeNull();
    await expect(repository.findServable({ imageId: randomUUID(), width: 640 })).resolves.toBeNull();
  });

  it("releases a deleted document's images: no longer served, listed for the sweep until it deletes them", async () => {
    const stored = await insertImage({ documentId, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://shop.example/cover.jpg" });

    await database.query("DELETE FROM documents WHERE id = $1", [documentId]);

    await expect(repository.findServable({ imageId: stored, width: 640 })).resolves.toBeNull();
    const released = await repository.listReleased(500);
    expect(released.find((image) => image.id === stored)?.renditions.map((entry) => entry.objectPath)).toEqual([
      "workspaces/w/document-image-320",
      "workspaces/w/document-image-640",
    ]);
    await repository.deleteReleased([stored]);
    await expect(database.query("SELECT id FROM document_images WHERE id = $1", [stored])).resolves.toEqual([]);
  });

  it("counts, for each primary, the documents in the workspace that name the same picture as theirs", async () => {
    const shared = "https://shop.example/banner.jpg";
    const documents = [documentId, randomUUID(), randomUUID()];
    for (const id of documents.slice(1)) await insertDocument(id, workspaceId);
    for (const id of documents) {
      await insertImage({ documentId: id, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: shared });
    }
    await insertImage({ documentId: otherDocumentId, workspaceId: otherWorkspaceId, role: "primary", status: "stored", position: 0, sourceUrl: shared });
    await insertImage({ documentId, workspaceId, role: "inline", status: "stored", position: 1, chunkId, sourceUrl: `${shared}?inline` });

    const rows = await repository.listStoredForEvidence({ workspaceId, documentIds: [documentId], chunkIds: [chunkId], primaryDocumentCountLimit: 6 });

    expect(rows.map((row) => [row.role, row.primaryDocumentCount])).toEqual([["primary", 3], ["inline", 0]]);
  });

  it("stops counting the documents that share a primary at the limit asked for", async () => {
    const shared = "https://shop.example/site-banner.jpg";
    const documents = [documentId, ...Array.from({ length: 7 }, () => randomUUID())];
    for (const id of documents.slice(1)) await insertDocument(id, workspaceId);
    for (const id of documents) {
      await insertImage({ documentId: id, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: shared });
    }

    const rows = await repository.listStoredForEvidence({ workspaceId, documentIds: [documentId], chunkIds: [], primaryDocumentCountLimit: 6 });

    expect(rows.map((row) => row.primaryDocumentCount)).toEqual([6]);
  });

  it("records what the content names: new addresses pending, kept ones re-placed, the rest released", async () => {
    const place = (sourceUrl: string, position: number, role: "primary" | "inline" = "primary", textOffset: number | null = null) =>
      ({ sourceUrl, role, alt: "", caption: null, position, textOffset });
    const named = [place("https://shop.example/cover.jpg", 0), place("https://shop.example/ridge.jpg", 1, "inline", 40)];
    const first = await repository.recordCandidates({ workspaceId, documentId, images: named });
    const stillPending = await repository.recordCandidates({ workspaceId, documentId, images: named });
    for (const row of await repository.listForCapture({ workspaceId, documentId })) {
      await repository.markStored({ id: row.id, chunkId, width: 800, height: 600, sha256: `sha-${row.id}`, sourceEtag: null, renditions: [rendition(320)] });
    }
    const unchanged = await repository.recordCandidates({ workspaceId, documentId, images: named });
    const moved = await repository.recordCandidates({
      workspaceId, documentId,
      images: [place("https://shop.example/ridge.jpg", 0, "inline", 90)],
    });

    expect([first.captureNeeded, stillPending.captureNeeded, unchanged.captureNeeded, moved.captureNeeded]).toEqual([true, true, false, true]);
    const rows = await repository.listForCapture({ workspaceId, documentId });
    expect(rows.map((row) => [row.sourceUrl, row.status, row.position, row.textOffset])).toEqual([
      ["https://shop.example/ridge.jpg", "stored", 0, 90],
    ]);
    expect((await repository.listReleased(500)).length).toBeGreaterThan(0);
    await expect(repository.hasImages(documentId)).resolves.toBe(true);
    await expect(repository.hasImages(otherDocumentId)).resolves.toBe(false);
  });

  it("stores, re-anchors, skips and resets an image as capture decides", async () => {
    const id = await insertImage({ documentId, workspaceId, role: "inline", status: "pending", position: 0, sourceUrl: "https://shop.example/ridge.jpg" });

    await expect(repository.markStored({
      id, chunkId, width: 800, height: 600, sha256: "sha-ridge", sourceEtag: '"r1"', renditions: [rendition(320), rendition(640)],
    })).resolves.toBe(true);
    const otherChunk = randomUUID();
    await repository.reanchor({ id, chunkId: otherChunk });
    const [stored] = await repository.listForCapture({ workspaceId, documentId });
    expect(stored).toMatchObject({ status: "stored", chunkId: otherChunk, sourceEtag: '"r1"', sha256: "sha-ridge" });
    await expect(repository.findServable({ imageId: id, width: 320 })).resolves.not.toBeNull();

    const cleared = await repository.markSkipped(id);
    expect(cleared.map((entry) => entry.width)).toEqual([320, 640]);
    await expect(repository.findServable({ imageId: id, width: 320 })).resolves.toBeNull();
    const [skipped] = await repository.listForCapture({ workspaceId, documentId });
    expect(skipped).toMatchObject({ status: "skipped", renditions: [], sha256: null });
    await expect(repository.markStored({ id: randomUUID(), chunkId: null, width: 1, height: 1, sha256: "x", sourceEtag: null, renditions: [rendition(320)] }))
      .resolves.toBe(false);
  });

  it("never stores or re-anchors an image its document released, and sends a released one it could not sweep to the back", async () => {
    const released = await insertImage({ documentId, workspaceId, role: "inline", status: "pending", position: 0, sourceUrl: "https://shop.example/a.jpg" });
    const later = await insertImage({ documentId, workspaceId, role: "inline", status: "pending", position: 1, sourceUrl: "https://shop.example/b.jpg" });
    await database.query("UPDATE document_images SET document_id = NULL, updated_at = now() - interval '1 hour' WHERE id = $1", [released]);
    await database.query("UPDATE document_images SET document_id = NULL, updated_at = now() - interval '30 minutes' WHERE id = $1", [later]);

    await expect(repository.markStored({
      id: released, chunkId, width: 800, height: 600, sha256: "sha-a", sourceEtag: null, renditions: [rendition(320)],
    })).resolves.toBe(false);
    await repository.reanchor({ id: released, chunkId });
    const [row] = await database.query<{ status: string; chunk_id: string | null }>("SELECT status, chunk_id FROM document_images WHERE id = $1", [released]);
    expect(row).toEqual({ status: "pending", chunk_id: null });

    await repository.touchReleased([released]);
    const order = (await repository.listReleased(500)).map((image) => image.id).filter((id) => id === released || id === later);
    expect(order).toEqual([later, released]);
  });
});
