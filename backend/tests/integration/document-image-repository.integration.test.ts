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
    documentId = randomUUID();
    otherDocumentId = randomUUID();
    await insertDocument(documentId, workspaceId);
    await insertDocument(otherDocumentId, otherWorkspaceId);
  });

  afterAll(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = ANY($1)", [[workspaceId, otherWorkspaceId]])
      .catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reads only stored images: primaries of the documents and inline images of the chunks", async () => {
    const primary = await insertImage({ documentId, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://shop.example/cover.jpg" });
    const inline = await insertImage({ documentId, workspaceId, role: "inline", status: "stored", position: 1, chunkId, sourceUrl: "https://shop.example/ridge.jpg" });
    await insertImage({ documentId, workspaceId, role: "inline", status: "pending", position: 2, chunkId, sourceUrl: "https://shop.example/pending.jpg" });
    await insertImage({ documentId, workspaceId, role: "inline", status: "stored", position: 3, chunkId: randomUUID(), sourceUrl: "https://shop.example/elsewhere.jpg" });

    const rows = await repository.listStoredForEvidence({ workspaceId, documentIds: [documentId], chunkIds: [chunkId] });

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
    });
    expect(rows.find((row) => row.id === inline)?.chunkId).toBe(chunkId);
  });

  it("never reads another workspace's images", async () => {
    await insertImage({ documentId: otherDocumentId, workspaceId: otherWorkspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://other.example/cover.jpg" });

    const rows = await repository.listStoredForEvidence({ workspaceId, documentIds: [otherDocumentId], chunkIds: [] });

    expect(rows).toEqual([]);
  });

  it("asks nothing of the database for empty evidence", async () => {
    await expect(repository.listStoredForEvidence({ workspaceId, documentIds: [], chunkIds: [] })).resolves.toEqual([]);
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

  it("deletes a document's images with the document", async () => {
    const stored = await insertImage({ documentId, workspaceId, role: "primary", status: "stored", position: 0, sourceUrl: "https://shop.example/cover.jpg" });

    await database.query("DELETE FROM documents WHERE id = $1", [documentId]);

    await expect(repository.findServable({ imageId: stored, width: 640 })).resolves.toBeNull();
    await expect(database.query("SELECT id FROM document_images WHERE id = $1", [stored])).resolves.toEqual([]);
  });
});
