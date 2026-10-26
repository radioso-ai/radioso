import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { deriveLexicalQueryPlan } from "../../src/modules/retrieval/domain/lexicalQueryPlan.js";
import type { LexicalQueryPlan } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { LexicalMatchMode } from "../../src/modules/retrieval/domain/lexicalSomeTermsMatch.js";
import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { renderSearchText } from "../../src/modules/retrieval/services/searchTextRenderer.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/domain/vectorSearch.js";
import { Database } from "../../src/shared/infra/database.js";
import { conversationQualityCorpus, MOUNTAIN_COURSE_DOC_ID } from "../fixtures/conversation-quality/corpus.js";
import {
  buildForeignEventsWorkspace,
  buildMidSizedBilingualWorkspace,
  ORGANISATION,
  WEEK_OF_SILENCE_EN_KEY,
  type SyntheticDocument,
} from "../fixtures/lexical-some-terms/midSizedBilingualCorpus.js";
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

  const insertChunk = async (
    key: string,
    title: string,
    text: string,
    workspace = workspaceId,
    document: { retrievalEnabled?: boolean; retrievalExpiresAt?: string } = {},
  ) => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, metadata, retrieval_enabled, retrieval_expires_at)
       VALUES ($1, $2, $3, $4, $4, 'ready', '{}'::jsonb, $5, $6)`,
      [documentId, workspace, title, text, document.retrievalEnabled ?? true, document.retrievalExpiresAt ?? null],
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

  const searchFor = async (query: string, matchMode: LexicalMatchMode = "all_or_some_terms") => {
    const { matches } = await search.search({ workspaceId, query, topK: 20, matchMode });
    return matches.map((result) => ({ key: keyOf(result), coverage: result.lexicalTermCoverage, result }));
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
    // Pages an operator took out of retrieval, and one past its retrieval expiry.
    await insertChunk(
      "disabled_stay",
      "Supercoscienti: archivio",
      "Archivio Supercoscienti: pernottamento e preventivo completo per l'evento.",
      workspaceId,
      { retrievalEnabled: false },
    );
    await insertChunk(
      "expired_stay",
      "Supercoscienti: edizione passata",
      "Edizione passata Supercoscienti: pernottamento e preventivo completo per l'evento.",
      workspaceId,
      { retrievalExpiresAt: "2020-01-01T00:00:00.000Z" },
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

  it("finds a name written as two words in a chunk that writes it as one, as a partial match", async () => {
    const results = await searchFor("super coscienti");

    // The chunk holds neither word as written, so it is no all-terms match.
    expect(results[0]).toMatchObject({ key: "supercoscienti_stay", coverage: "some_terms" });
  });

  it("finds nothing when the only term the workspace holds is on most of its pages", async () => {
    // evento is on 31 of the workspace's 41 retrievable pages; nothing else in the query is.
    expect(await searchFor("preventivo costo parcheggio evento")).toEqual([]);
    const { someTermsPass } = await search.search({
      workspaceId,
      query: "preventivo costo parcheggio evento",
      topK: 20,
      matchMode: "all_or_some_terms",
    });
    expect(someTermsPass.outcome).toBe("ran");
  });

  it("keeps the all-terms hits when the some-terms pass runs out of time on real Postgres", async () => {
    // One connection, so the timeout check below reads the very connection the pass used.
    const slowDatabase = new Database(integrationDatabaseUrl, { poolMax: 1 });
    const runInTransaction = slowDatabase.withTransaction.bind(slowDatabase);
    // Slow the count statement: a sleep on the same connection, under the pass's own
    // transaction-local statement_timeout, so Postgres cancels it.
    slowDatabase.withTransaction = (callback) => runInTransaction((client) => callback(new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "query") {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return async (sql: string, params?: unknown[]) => {
          if (sql.includes("AS scope_count")) {
            await target.query("SELECT pg_sleep(2)");
          }
          return target.query(sql, params);
        };
      },
    })));
    try {
      const [poolDefault] = await slowDatabase.query<{ statement_timeout: string }>("SHOW statement_timeout");
      const warnings: Array<Record<string, unknown>> = [];
      const slowSearch = new PgLexicalSearch(slowDatabase, {
        someTermsTimeoutMs: 100,
        logger: { warn: (fields) => warnings.push(fields) },
      });

      const result = await slowSearch.search({
        workspaceId,
        query: "Festival delle arti gioiose",
        topK: 20,
        matchMode: "all_or_some_terms",
      });

      expect(result.someTermsPass.outcome).toBe("timed_out");
      expect(result.someTermsPass.durationMs).toBeLessThan(1_000);
      expect(result.matches.map((match) => [keyOf(match), match.lexicalTermCoverage]).sort()).toEqual([
        ["festival_program", "all_terms"],
        ["festival_stay", "all_terms"],
      ]);
      expect(warnings).toEqual([expect.objectContaining({ timeoutMs: 100, termCount: 4 })]);
      const [afterwards] = await slowDatabase.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(afterwards?.statement_timeout).toBe(poolDefault?.statement_timeout);
    } finally {
      await slowDatabase.close();
    }
  });

  it("finds the course page for an English question over an Italian corpus", async () => {
    const results = await searchFor("price overnight event Supercoscienti");

    expect(results.map(({ key, coverage }) => [key, coverage])).toEqual([["supercoscienti_stay", "some_terms"]]);
  });

  it("keeps to chunks holding every term when the caller asks for exact matching", async () => {
    expect(await searchFor("preventivo completo pernottamento evento", "all_terms")).toEqual([]);
    const { someTermsPass } = await search.search({
      workspaceId,
      query: "preventivo completo pernottamento evento",
      topK: 20,
      matchMode: "all_terms",
    });
    expect(someTermsPass.outcome).toBe("skipped");
  });

  it("reports a some-terms pass that ran", async () => {
    const result = await search.search({
      workspaceId,
      query: "preventivo completo pernottamento evento",
      topK: 20,
      matchMode: "all_or_some_terms",
    });

    expect(result.someTermsPass.outcome).toBe("ran");
    expect(result.someTermsPass.durationMs).toBeLessThan(5_000);
  });

  it("leaves out documents taken out of retrieval and documents past their retrieval expiry", async () => {
    for (const query of ["preventivo completo pernottamento evento", "Supercoscienti", "super coscienti"]) {
      const keys = (await searchFor(query)).map(({ key }) => key);
      expect(keys).not.toContain("disabled_stay");
      expect(keys).not.toContain("expired_stay");
    }
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

  it("keeps a chunk holding an excluded word out of the partial matches", async () => {
    // The festival page holds pernottamento, the query's rarest word, and also tenda.
    expect((await searchFor("pernottamento evento")).map(({ key }) => key)).toContain("festival_stay");

    const { matches, someTermsPass } = await search.search({
      workspaceId,
      query: "pernottamento evento -tenda",
      lexicalPlan: deriveLexicalQueryPlan("pernottamento evento -tenda"),
      topK: 20,
      matchMode: "all_or_some_terms",
    });

    expect(someTermsPass.outcome).toBe("ran");
    const keys = matches.map(keyOf);
    expect(keys).toContain("supercoscienti_stay");
    expect(keys).not.toContain("festival_stay");
  });

  it("stays inside the workspace", async () => {
    const results = await searchFor("pernottamento evento Supercoscienti");

    expect(results.map(({ key }) => key)).not.toContain("other_workspace_stay");
  });
});

// The lexical half of the `directive-withholds-figures-it` eval case, on that case's own
// corpus: whatever lexical query the model writes for "Quanto costa il corso di yoga in
// montagna?", the course page comes back first, including when the model writes request
// words that no page holds alongside the subject.
describeIntegration("PgLexicalSearch over the conversation-quality corpus", () => {
  const database = new Database(integrationDatabaseUrl);
  const search = new PgLexicalSearch(database);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const fixtureIdByChunk = new Map<string, string>();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Lexical Corpus Co", `lexical-corpus-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Lexical Corpus Workspace", `lexical-corpus-${workspaceId}`],
    );
    for (const document of conversationQualityCorpus) {
      const documentId = randomUUID();
      const chunkId = randomUUID();
      await database.query(
        `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, metadata, retrieval_enabled)
         VALUES ($1, $2, $3, $4, $4, 'ready', '{}'::jsonb, true)`,
        [documentId, workspaceId, document.title, document.content],
      );
      await database.query(
        `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
         VALUES ($1, $2, $3, 0, $4, $5, '{}'::jsonb)`,
        [chunkId, documentId, workspaceId, document.content, renderSearchText({ title: document.title, content: document.content })],
      );
      fixtureIdByChunk.set(chunkId, document.id);
    }
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const topMatch = async (query: string, matchMode: LexicalMatchMode) => {
    const { matches, someTermsPass } = await search.search({ workspaceId, query, topK: 20, matchMode });
    const [first] = matches;
    return {
      document: first ? fixtureIdByChunk.get(first.chunkId) : undefined,
      coverage: first?.lexicalTermCoverage,
      outcome: someTermsPass.outcome,
    };
  };

  it("finds the course page first for the subject itself, in both modes", async () => {
    for (const matchMode of ["all_terms", "all_or_some_terms"] as const) {
      expect(await topMatch("corso di yoga in montagna", matchMode))
        .toMatchObject({ document: MOUNTAIN_COURSE_DOC_ID, coverage: "all_terms" });
    }
  });

  it("finds the course page first when the query adds request words no page holds", async () => {
    for (const query of ["prezzo corso di yoga in montagna", "costo corso yoga montagna", "Quanto costa il corso di yoga in montagna?"]) {
      expect(await topMatch(query, "all_terms")).toMatchObject({ document: undefined });
      expect(await topMatch(query, "all_or_some_terms"))
        .toMatchObject({ document: MOUNTAIN_COURSE_DOC_ID, coverage: "some_terms", outcome: "ran" });
    }
  });
});

// Reproduces #1634: on a mid-sized bilingual workspace, the some-terms pass for
// "<organisation> Europe week of 29 November 2027 events" ran past its budget. The
// workspace shares its hash partition with another workspace in which "Europe" and
// "events" are frequent, and the organisation's name is on every one of its own chunks.
describeIntegration("PgLexicalSearch on a mid-sized bilingual workspace", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const keyByChunkId = new Map<string, string>();
  let foreignWorkspaceId = randomUUID();
  const query = `${ORGANISATION} Europe week of 29 November 2027 events`;

  const insertWorkspaceDocuments = async (workspace: string, documents: SyntheticDocument[]) => {
    const documentIds = documents.map(() => randomUUID());
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, metadata, retrieval_enabled)
       SELECT id, $1, title, body, body, 'ready', '{}'::jsonb, true
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS t(id, title, body)`,
      [
        workspace,
        documentIds,
        documents.map((document) => document.title),
        documents.map((document) => document.chunks.map((chunk) => chunk.searchText).join("\n")),
      ],
    );
    const chunks = documents.flatMap((document, index) =>
      document.chunks.map((chunk) => ({ id: randomUUID(), documentId: documentIds[index], chunk })));
    for (const { id, chunk } of chunks) {
      keyByChunkId.set(id, chunk.key);
    }
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
       SELECT id, document_id, $1, chunk_index, body, body, '{}'::jsonb
       FROM unnest($2::uuid[], $3::uuid[], $4::int[], $5::text[]) AS t(id, document_id, chunk_index, body)`,
      [
        workspace,
        chunks.map(({ id }) => id),
        chunks.map(({ documentId }) => documentId),
        chunks.map(({ chunk }) => chunk.chunkIndex),
        chunks.map(({ chunk }) => chunk.searchText),
      ],
    );
  };

  // Runs the some-terms statements as usual, and keeps each one's plan for the same
  // parameters; with `analyze`, the plan carries the rows each step actually saw.
  const searchRecordingPlans = async (
    options: { query?: string; lexicalPlan?: LexicalQueryPlan; topK?: number; analyze?: boolean } = {},
  ) => {
    const plans: unknown[] = [];
    const recording = new Database(integrationDatabaseUrl, { poolMax: 1 });
    const runInTransaction = recording.withTransaction.bind(recording);
    recording.withTransaction = (callback) => runInTransaction((client) => callback(new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "query") {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return async (sql: string, params?: unknown[]) => {
          if (!sql.startsWith("SELECT set_config")) {
            const explained = await target.query(`EXPLAIN (${options.analyze ? "ANALYZE, " : ""}FORMAT JSON) ${sql}`, params);
            plans.push((explained.rows[0] as Record<string, unknown>)["QUERY PLAN"]);
          }
          return target.query(sql, params);
        };
      },
    })));
    try {
      const result = await new PgLexicalSearch(recording, { someTermsTimeoutMs: 10_000 }).search({
        workspaceId,
        query: options.query ?? query,
        lexicalPlan: options.lexicalPlan,
        topK: options.topK ?? 20,
        matchMode: "all_or_some_terms",
      });
      return { result, plans };
    } finally {
      await recording.close();
    }
  };

  type PlanNode = {
    "Relation Name"?: string;
    Filter?: string;
    "Node Type"?: string;
    "Rows Removed by Filter"?: number;
    Plans?: PlanNode[];
  };
  const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
  const nodesOf = (plan: unknown): PlanNode[] => (plan as Array<{ Plan: PlanNode }>).flatMap(({ Plan }) => planNodes(Plan));
  const tsvectorParsesPerRow = (node: PlanNode): number => node.Filter?.match(/to_tsvector\(/g)?.length ?? 0;

  beforeAll(async () => {
    const [{ remainder } = { remainder: -1 }] = await database.query<{ remainder: number }>(
      `SELECT r AS remainder FROM generate_series(0, 15) AS r
       WHERE satisfies_hash_partition('public.chunks'::regclass, 16, r, $1::uuid)`,
      [workspaceId],
    );
    // Put the other workspace in the same chunk partition.
    for (;;) {
      const [placed] = await database.query<{ same: boolean }>(
        "SELECT satisfies_hash_partition('public.chunks'::regclass, 16, $2, $1::uuid) AS same",
        [foreignWorkspaceId, remainder],
      );
      if (placed?.same) {
        break;
      }
      foreignWorkspaceId = randomUUID();
    }

    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Mid-sized Lexical Co", `lexical-mid-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
      [workspaceId, accountId, "Mid-sized Workspace", `lexical-mid-${workspaceId}`, foreignWorkspaceId, "Events Workspace", `lexical-mid-${foreignWorkspaceId}`],
    );
    await insertWorkspaceDocuments(workspaceId, buildMidSizedBilingualWorkspace());
    await insertWorkspaceDocuments(foreignWorkspaceId, buildForeignEventsWorkspace(3_000));

    // The state autovacuum leaves after an ingestion: fresh statistics, so Postgres knows
    // which words are frequent in the partition, and the full-text index's pending list
    // merged into the index.
    const [partition] = await database.query<{ name: string }>(
      "SELECT tableoid::regclass::text AS name FROM chunks WHERE workspace_id = $1 LIMIT 1",
      [workspaceId],
    );
    await database.query(`VACUUM ANALYZE ${partition?.name ?? "chunks"}`);
    await database.query("ANALYZE documents");
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("finds that week's event page first, as a partial match", async () => {
    const { result } = await searchRecordingPlans();

    expect(result.someTermsPass.outcome).toBe("ran");
    const keys = result.matches.map((match) => keyByChunkId.get(match.chunkId));
    expect(keys[0]).toBe(WEEK_OF_SILENCE_EN_KEY);
    expect(result.matches.length).toBeGreaterThan(1);
    expect(result.matches.every((match) => match.lexicalTermCoverage === "some_terms")).toBe(true);
    expect(keys.some((key) => key?.startsWith("foreign_"))).toBe(false);
  });

  it("looks each term up through the full-text index instead of re-reading the workspace's chunks", async () => {
    const { plans } = await searchRecordingPlans();

    expect(plans).toHaveLength(2);
    // A chunk scan filtering on a recomputed tsvector parses every chunk it reads; the
    // terms frequent in the partition made Postgres read the whole workspace that way.
    const recomputedTsvectorScans = plans
      .flatMap((plan) => (plan as Array<{ Plan: PlanNode }>).flatMap(({ Plan }) => planNodes(Plan)))
      .filter((node) => node["Relation Name"]?.startsWith("chunks") && node.Filter?.includes("to_tsvector"))
      .map((node) => `${node["Node Type"]} on ${node["Relation Name"]}: ${node.Filter}`);
    expect(recomputedTsvectorScans).toEqual([]);
  });

  it("parses each candidate's text once to check all of the query's exclusions", async () => {
    const excluding = "week of silence -Lago -Sereno -2027";
    const { result, plans } = await searchRecordingPlans({ query: excluding, lexicalPlan: deriveLexicalQueryPlan(excluding) });

    // The week of silence is at Lago Sereno, in 2027.
    expect(result.someTermsPass.outcome).toBe("ran");
    expect(result.matches.map((match) => keyByChunkId.get(match.chunkId))).not.toContain(WEEK_OF_SILENCE_EN_KEY);
    expect(plans).toHaveLength(2);
    const [lookup, ranking] = plans;
    const chunkScans = (plan: unknown) => nodesOf(plan).filter((node) => node["Relation Name"]?.startsWith("chunks"));
    expect(chunkScans(lookup).every((node) => tsvectorParsesPerRow(node) === 0)).toBe(true);
    // The candidates' scan checks the three excluded words against one parse of each chunk.
    expect(chunkScans(ranking).map(tsvectorParsesPerRow).filter((parses) => parses > 0)).toEqual([1]);
  });

  it("keeps the heaviest chunks, in order, when fewer fit than clear the floors", async () => {
    const all = await searchRecordingPlans();
    const { result, plans } = await searchRecordingPlans({ topK: 3, analyze: true });

    expect(all.result.matches.length).toBeGreaterThan(3);
    expect(result.matches.map((match) => match.chunkId))
      .toEqual(all.result.matches.slice(0, 3).map((match) => match.chunkId));
    // The lighter candidates are dropped before their text is parsed for a rank.
    const cut = nodesOf(plans[1]).find((node) => node.Filter?.includes("covered_weight >="));
    expect(cut?.["Rows Removed by Filter"]).toBe(all.result.matches.length - 3);
  });
});
