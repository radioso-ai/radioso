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

  const refOf = (document: { id: string; revision: number }) => ({ workspaceId, documentId: document.id, revision: document.revision });

  it("finds nothing for a document never enriched, and returns what was saved", async () => {
    const document = await createDocument();

    expect(await replies.find(refOf(document))).toBeNull();
    await replies.save(refOf(document), REPLY);

    expect(await replies.find(refOf(document))).toEqual(REPLY);
  });

  it("neither reads nor writes across workspaces", async () => {
    const document = await createDocument();

    await replies.save({ ...refOf(document), workspaceId: otherWorkspaceId }, REPLY);
    expect(await replies.find(refOf(document))).toBeNull();

    await replies.save(refOf(document), REPLY);
    expect(await replies.find({ ...refOf(document), workspaceId: otherWorkspaceId })).toBeNull();
  });

  it("is not an edit of the document: revision and updated_at stay as they were", async () => {
    const document = await createDocument();

    await replies.save(refOf(document), REPLY);
    await replies.clear(refOf(document));

    const current = await documents.findByIdAndWorkspaceId(document.id, workspaceId);
    expect(current?.revision).toBe(document.revision);
    expect(current?.updatedAt.toISOString()).toBe(document.updatedAt.toISOString());
  });

  it("clears a stored reply on request", async () => {
    const document = await createDocument();
    await replies.save(refOf(document), REPLY);

    await replies.clear(refOf(document));

    expect(await replies.find(refOf(document))).toBeNull();
  });

  it("lets a superseded revision neither store nor clear a reply", async () => {
    const document = await createDocument();
    const resynced = await documents.createAndQueue({
      workspaceId,
      title: "Summer workshop",
      sourceContent: "Dates: July 17-19, 2026.",
      markdownContent: "Dates: July 17-19, 2026.",
      metadata: { audience: "staff" },
      externalDocumentId: document.externalDocumentId,
    });

    await replies.save(refOf(document), REPLY);
    expect(await replies.find(refOf(resynced))).toBeNull();

    await replies.save(refOf(resynced), REPLY);
    await replies.clear(refOf(document));
    expect(await replies.find(refOf(resynced))).toEqual(REPLY);
  });

  it("drops the reply when a re-sync changes the text, and keeps it when only metadata changes", async () => {
    const document = await createDocument();
    await replies.save(refOf(document), REPLY);

    const retagged = await documents.createAndQueue({
      workspaceId,
      title: "Summer workshop",
      sourceContent: "Dates: July 17-19, 2026.",
      markdownContent: "Dates: July 17-19, 2026.",
      metadata: { audience: "staff" },
      externalDocumentId: document.externalDocumentId,
    });
    expect(retagged.id).toBe(document.id);
    expect(await replies.find(refOf(retagged))).toEqual(REPLY);

    const edited = await documents.createAndQueue({
      workspaceId,
      title: "Summer workshop",
      sourceContent: "Dates: July 17-19, 2026. Bring water.",
      markdownContent: "Dates: July 17-19, 2026. Bring water.",
      externalDocumentId: document.externalDocumentId,
    });
    expect(edited.revision).toBe(document.revision + 2);
    expect(await replies.find(refOf(edited))).toBeNull();
  });

  it("drops the reply when an update changes the title or the text", async () => {
    const document = await createDocument();
    const update = (title: string, markdownContent: string) =>
      documents.updateAndQueue({ documentId: document.id, workspaceId, title, sourceContent: markdownContent, markdownContent });
    await replies.save(refOf(document), REPLY);

    const unchanged = await update("Summer workshop", "Dates: July 17-19, 2026.");
    expect(await replies.find(refOf(unchanged))).toEqual(REPLY);

    const retitled = await update("Summer workshop 2026", "Dates: July 17-19, 2026.");
    expect(await replies.find(refOf(retitled))).toBeNull();

    await replies.save(refOf(retitled), REPLY);
    const rewritten = await update("Summer workshop 2026", "Dates: July 24-26, 2026.");
    expect(await replies.find(refOf(rewritten))).toBeNull();
  });

  it("drops the reply when processing derives different text from the stored file", async () => {
    const document = await createDocument();
    await replies.save(refOf(document), REPLY);

    await documents.updateDerivedContentForRevision({
      ...refOf(document),
      sourceContent: "Dates: July 17-19, 2026.",
      markdownContent: "Dates: July 17-19, 2026.",
    });
    expect(await replies.find(refOf(document))).toEqual(REPLY);

    await documents.updateDerivedContentForRevision({
      ...refOf(document),
      sourceContent: "Dates: 17-19 July 2026.",
      markdownContent: "Dates: 17-19 July 2026.",
    });
    expect(await replies.find(refOf(document))).toBeNull();
  });

  it("goes with the document when it is deleted", async () => {
    const document = await createDocument();
    await replies.save(refOf(document), REPLY);

    await documents.deleteByIdAndWorkspaceId(document.id, workspaceId);

    expect(await replies.find(refOf(document))).toBeNull();
  });
});
