import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/domain/vectorSearch.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// Reproduces production conversation d9d2becd (#1576): the lexical query
// "preventivo completo pernottamento evento" mixes request words with subject words, so a
// search that requires every term found nothing. The fixture corpus is Italian, with the
// relevant course page among many pages that share only frequent words with the query.
describeIntegration("PgLexicalSearch (Postgres full-text search)", () => {
  const database = new Database(integrationDatabaseUrl);
  const search = new PgLexicalSearch(database);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const chunkIds = new Map<string, string>();

  const insertChunk = async (key: string, title: string, text: string, workspace = workspaceId) => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, metadata, retrieval_enabled)
       VALUES ($1, $2, $3, $4, $4, 'ready', '{}'::jsonb, true)`,
      [documentId, workspace, title, text],
    );
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
       VALUES ($1, $2, $3, 0, $4, $5, '{}'::jsonb)`,
      [chunkId, documentId, workspace, text, `Title: ${title}\n\n${text}`],
    );
    chunkIds.set(key, chunkId);
  };

  const keyOf = (chunk: RetrievedChunk): string =>
    [...chunkIds.entries()].find(([, id]) => id === chunk.chunkId)?.[0] ?? "unknown";

  const searchFor = async (query: string, topK = 20) => {
    const results = await search.search({ workspaceId, query, topK });
    return results.map((result) => ({ key: keyOf(result), coverage: result.lexicalTermCoverage, result }));
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Lexical Search Co", `lexical-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
      [workspaceId, accountId, "Lexical Workspace", `lexical-${workspaceId}`, otherWorkspaceId, "Other Lexical Workspace", `lexical-${otherWorkspaceId}`],
    );

    await insertChunk(
      "supercoscienti_stay",
      "Le soluzioni Supercoscienti",
      "Le soluzioni Supercoscienti: pernottamento in camera doppia durante l'evento, con colazione e cena incluse.",
    );
    await insertChunk(
      "festival_stay",
      "Festival delle arti gioiose",
      "Il Festival delle arti gioiose offre il pernottamento in tenda per tutta la durata.",
    );
    await insertChunk(
      "festival_program",
      "Festival delle arti gioiose: programma",
      "Il programma del Festival delle arti gioiose comprende concerti e laboratori.",
    );
    // Pages that share only frequent words with the query: "evento", "completo", and
    // the function words every Italian page holds.
    for (let index = 0; index < 30; index += 1) {
      await insertChunk(
        `event_noise_${index}`,
        `Calendario ${index}`,
        `Il programma di meditazione per il gruppo e la sera dell'evento numero ${index} è aperto a tutti.`,
      );
    }
    for (let index = 0; index < 8; index += 1) {
      await insertChunk(
        `complete_noise_${index}`,
        `Corso ${index}`,
        `Il corso completo di yoga per principianti, lezione ${index}, si tiene di mattina.`,
      );
    }
    await insertChunk(
      "other_workspace_stay",
      "Le soluzioni Supercoscienti",
      "Le soluzioni Supercoscienti: pernottamento durante l'evento.",
      otherWorkspaceId,
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("finds the course page for a request-phrased query that no chunk holds in full", async () => {
    const results = await searchFor("preventivo completo pernottamento evento");

    expect(results[0]).toMatchObject({ key: "supercoscienti_stay", coverage: "some_terms" });
    // Pages holding only the query's frequent words stay out.
    expect(results.some(({ key }) => key.startsWith("event_noise_") || key.startsWith("complete_noise_"))).toBe(false);
    expect(results.every(({ coverage }) => coverage === "some_terms")).toBe(true);
  });

  it("ranks the chunk holding more of the query's rare terms first", async () => {
    const results = await searchFor("preventivo completo pernottamento evento");

    const keys = results.map(({ key }) => key);
    expect(keys.indexOf("supercoscienti_stay")).toBeLessThan(keys.indexOf("festival_stay"));
    expect(results[0].result.similarity).toBeGreaterThan(results[1].result.similarity);
  });

  it("finds a name written as two words in a chunk that writes it as one", async () => {
    const results = await searchFor("super coscienti");

    expect(results[0]).toMatchObject({ key: "supercoscienti_stay", coverage: "all_terms" });
  });

  it("finds the course page for a full question with its function words", async () => {
    const results = await searchFor("Quanto costa il pernottamento per l'evento dei Supercoscienti?");

    expect(results[0]).toMatchObject({ key: "supercoscienti_stay", coverage: "some_terms" });
    const noiseRank = results.findIndex(({ key }) => key.startsWith("event_noise_") || key.startsWith("complete_noise_"));
    expect(noiseRank === -1 || noiseRank > 0).toBe(true);
  });

  it("keeps an exact-name lookup's all-terms chunks first, ahead of partial matches", async () => {
    const results = await searchFor("Festival delle arti gioiose");

    const allTerms = results.filter(({ coverage }) => coverage === "all_terms").map(({ key }) => key);
    expect(allTerms.sort()).toEqual(["festival_program", "festival_stay"]);
    expect(results.slice(0, 2).every(({ coverage }) => coverage === "all_terms")).toBe(true);
  });

  it("answers a one-word name lookup with the chunk holding it and nothing else", async () => {
    const results = await searchFor("Supercoscienti");

    expect(results.map(({ key, coverage }) => [key, coverage])).toEqual([["supercoscienti_stay", "all_terms"]]);
  });

  it("reads tsquery operators in the query as plain words", async () => {
    const results = await searchFor("pernottamento & !evento | (super:* <-> coscienti) 'x");

    expect(results[0]?.key).toBe("supercoscienti_stay");
  });

  it("stays inside the workspace", async () => {
    const results = await searchFor("pernottamento evento Supercoscienti");

    expect(results.map(({ key }) => key)).not.toContain("other_workspace_stay");
  });
});
