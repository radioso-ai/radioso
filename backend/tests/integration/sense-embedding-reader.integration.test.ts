import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSenseEmbeddingReader } from "../../src/modules/retrieval/services/senseGroupingService.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }

  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("PostgresSenseEmbeddingReader", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  // chunks.id is uuid; the read must compare it against a uuid[] bind, not text[].
  // A text[] cast makes Postgres reject the query with "operator does not exist:
  // uuid = text" at execution time, even when no rows match — which broke the
  // retrieval-sense detector before it could ask or pick a sense.
  it("queries chunk embeddings by uuid id without a uuid/text operator error", async () => {
    const reader = new PostgresSenseEmbeddingReader(database);

    const result = await reader.readChunkEmbeddings({
      workspaceId: randomUUID(),
      chunkIds: [randomUUID(), randomUUID()],
    });

    expect(result.size).toBe(0);
  });
});
