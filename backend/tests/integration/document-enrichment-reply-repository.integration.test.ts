import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { DocumentEnrichmentReplyRepository } from "../../src/db/repositories/documentEnrichmentReplyRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const REPLY = {
  requestFingerprint: "fingerprint-1",
  model: "gpt-5.4-mini",
  output: { type: "event", confidence: 0.9, facts: [{ kind: "event_date", quote: "July 17-19, 2026", dateFrom: "2026-07-17", dateTo: "2026-07-19", unresolvedText: null }] },
};

describeIntegration("DocumentEnrichmentReplyRepository (Postgres)", () => {
  let database: Database;
  let documents: DocumentRepository;
  let replies: DocumentEnrichmentReplyRepository;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl);
    documents = new DocumentRepository(database.kysely);
    replies = new DocumentEnrichmentReplyRepository(database.kysely);
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Enrichment Reply Co", `enrichment-reply-${accountId}@example.com`, "hash"],
    );
    for (const id of [workspaceId, otherWorkspaceId]) {
      await database.query(
        `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
        [id, accountId, "Enrichment Reply Workspace", `enrichment-reply-${id}`],
      );
    }
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createDocument = (content = "Dates: July 17-19, 2026.") =>
    documents.createAndQueue({
      workspaceId,
      title: "Summer workshop",
      sourceContent: content,
      markdownContent: content,
      externalDocumentId: `workshop-${randomUUID()}`,
    });

  it("finds nothing for a document never enriched, and returns what was saved", async () => {
    const document = await createDocument();
    const ref = { workspaceId, documentId: document.id };

    expect(await replies.find(ref)).toBeNull();
    await replies.save(ref, REPLY);

    expect(await replies.find(ref)).toEqual(REPLY);
  });

  it("neither reads nor writes across workspaces", async () => {
    const document = await createDocument();

    await replies.save({ workspaceId: otherWorkspaceId, documentId: document.id }, REPLY);
    expect(await replies.find({ workspaceId, documentId: document.id })).toBeNull();

    await replies.save({ workspaceId, documentId: document.id }, REPLY);
    expect(await replies.find({ workspaceId: otherWorkspaceId, documentId: document.id })).toBeNull();
  });

  it("is not an edit of the document: revision and updated_at stay as they were", async () => {
    const document = await createDocument();

    await replies.save({ workspaceId, documentId: document.id }, REPLY);

    const current = await documents.findByIdAndWorkspaceId(document.id, workspaceId);
    expect(current?.revision).toBe(document.revision);
    expect(current?.updatedAt.toISOString()).toBe(document.updatedAt.toISOString());
  });

  it("survives a re-sync that replaces the document and resets its provenance", async () => {
    const document = await createDocument();
    await replies.save({ workspaceId, documentId: document.id }, REPLY);

    const resynced = await documents.createAndQueue({
      workspaceId,
      title: "Summer workshop",
      sourceContent: "Dates: July 17-19, 2026. Bring water.",
      markdownContent: "Dates: July 17-19, 2026. Bring water.",
      externalDocumentId: document.externalDocumentId,
    });

    expect(resynced.id).toBe(document.id);
    expect(resynced.revision).toBe(document.revision + 1);
    expect(await replies.find({ workspaceId, documentId: document.id })).toEqual(REPLY);
  });

  it("goes with the document when it is deleted", async () => {
    const document = await createDocument();
    await replies.save({ workspaceId, documentId: document.id }, REPLY);

    await documents.deleteByIdAndWorkspaceId(document.id, workspaceId);

    expect(await replies.find({ workspaceId, documentId: document.id })).toBeNull();
  });
});
