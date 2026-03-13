import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { ChunkRepository } from "../../src/db/repositories/chunkRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { PgVectorSearch } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { Database } from "../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const describeIfDatabase = integrationDatabaseUrl ? describe : describe.skip;

describeIfDatabase("persistence integration", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationPath = path.resolve(__dirname, "../../src/db/migrations/001_init.sql");

  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    const migrationSql = await readFile(migrationPath, "utf8");
    await database.pool.query(migrationSql);
  });

  afterAll(async () => {
    await database.close();
  });

  it("persists records and returns account-scoped vector matches", async () => {
    const accountRepository = new AccountRepository(database);
    const documentRepository = new DocumentRepository(database);
    const chunkRepository = new ChunkRepository(database);
    const vectorSearch = new PgVectorSearch(database);

    const accountA = await accountRepository.create({
      email: `persist-a-${randomUUID()}@example.com`,
      passwordHash: "hash-a",
    });
    const accountB = await accountRepository.create({
      email: `persist-b-${randomUUID()}@example.com`,
      passwordHash: "hash-b",
    });

    const documentA = await documentRepository.create({
      accountId: accountA.id,
      title: "Guide A",
      sourceContent: "The test page explains ingestion.",
      markdownContent: "The test page explains ingestion.",
      status: "ready",
    });
    const documentB = await documentRepository.create({
      accountId: accountB.id,
      title: "Guide B",
      sourceContent: "Other account content.",
      markdownContent: "Other account content.",
      status: "ready",
    });

    await chunkRepository.replaceForDocument(documentA.id, [
      {
        id: randomUUID(),
        documentId: documentA.id,
        accountId: accountA.id,
        chunkIndex: 0,
        content: "The test page explains ingestion and parsing.",
        embedding: [1, 0, 0],
        startOffset: 0,
        endOffset: 43,
        createdAt: new Date(),
      },
    ]);
    await chunkRepository.replaceForDocument(documentB.id, [
      {
        id: randomUUID(),
        documentId: documentB.id,
        accountId: accountB.id,
        chunkIndex: 0,
        content: "This belongs to another account.",
        embedding: [0, 1, 0],
        startOffset: 0,
        endOffset: 31,
        createdAt: new Date(),
      },
    ]);

    const matches = await vectorSearch.search({
      accountId: accountA.id,
      queryEmbedding: [1, 0, 0],
      topK: 5,
      similarityThreshold: 0.1,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].documentId).toBe(documentA.id);

    await database.query("DELETE FROM chunks WHERE account_id = $1 OR account_id = $2", [accountA.id, accountB.id]);
    await database.query("DELETE FROM documents WHERE account_id = $1 OR account_id = $2", [accountA.id, accountB.id]);
    await database.query("DELETE FROM accounts WHERE id = $1 OR id = $2", [accountA.id, accountB.id]);
  });
});
