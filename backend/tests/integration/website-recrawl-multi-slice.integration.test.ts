import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { documentEventEraser } from "../../src/app/composition/workspaceEventLog.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { WebsiteMissingPageRepository } from "../../src/db/repositories/websiteMissingPageRepository.js";
import type { WebsiteCrawlPage, WebsiteCrawlerProvider } from "../../src/modules/websiteCrawler/provider.js";
import type { WebsiteCrawlCheckpoint } from "../../src/modules/websiteCrawler/policy.js";
import { WebsiteCrawlerService } from "../../src/modules/websiteCrawler/service.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

// A crawl longer than one two-minute slice: the first slice yields, the second finishes. The
// removal of missing pages has to count the pages the first slice saw as seen.
describeIntegration("A crawl that completes over two slices reconciles missing pages (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const documents = new DocumentRepository(database.kysely, documentEventEraser);
  const missingPages = new WebsiteMissingPageRepository(database.kysely);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();
  const site = "https://docs.example";
  const jobStartedAt = new Date("2026-11-21T09:00:00.000Z");
  const externalId = (path: string) => `website:${site}:${site}/${path}`;
  const page = (path: string): WebsiteCrawlPage => ({
    sourceUrl: `${site}/${path}`,
    canonicalUrl: `${site}/${path}`,
    title: path,
    content: `The ${path} page.`,
    metadata: {},
  });

  const service = new WebsiteCrawlerService({
    provider: {
      name: "two-slice-crawler",
      // Each slice crawls the pages the test hands it, and reports the links it dropped at a limit.
      crawl: async (request) => {
        const { droppedLinks = [], ...slice } = nextSlice(request.checkpoint);
        for (const url of droppedLinks) {
          await request.onCheckpointEvent?.({ type: "dropped", url, canonicalUrl: url });
        }
        return { provider: "two-slice-crawler", status: "completed", ...slice };
      },
    } satisfies WebsiteCrawlerProvider,
    documentIngestionService: {
      ingest: async (input) => {
        const [existing] = await database.query<{ id: string }>(
          "SELECT id FROM documents WHERE workspace_id = $1 AND source_id = $2 AND external_document_id = $3",
          [workspaceId, sourceId, input.externalDocumentId],
        );
        if (existing) return { documentId: existing.id, status: "ready" };
        const id = randomUUID();
        await database.query(
          `INSERT INTO documents (id, workspace_id, source_id, external_document_id, title, source_content, markdown_content, status)
           VALUES ($1, $2, $3, $4, $5, $6, $6, 'queued')`,
          [id, workspaceId, sourceId, input.externalDocumentId, input.title, input.content],
        );
        return { documentId: id, status: "queued" };
      },
      resolveSource: async () => ({ id: sourceId }),
      updateSourceSyncState: async () => undefined,
      reapMissingPages: (input) => documents.deleteMissingPagesBySourceAndExternalIds(input),
    },
    missingPages,
    auditService: audit,
    assertCrawlUrlAllowed: async () => undefined,
  });

  type Slice = { pages: WebsiteCrawlPage[]; outcome: "yielded" | "completed"; frontierExhausted?: boolean; droppedLinks?: string[] };
  let slices: Slice[] = [];
  const nextSlice = (_checkpoint: WebsiteCrawlCheckpoint | undefined) => {
    const slice = slices.shift();
    if (!slice) throw new Error("no slice left");
    return slice;
  };

  /** Runs the job's slices the way the worker does: each one resumes from the checkpoint the last one saved. */
  const crawlInSlices = async (trigger: "manual" | "scheduled", sliceScript: Slice[]) => {
    slices = [...sliceScript];
    let checkpoint: WebsiteCrawlCheckpoint | null = null;
    for (let slice = 0; slice < sliceScript.length; slice += 1) {
      const result = await service.crawlAndPublish({
        workspaceId,
        sourceId,
        url: site,
        limit: 100,
        trigger,
        checkpoint,
        crawlStartedAt: jobStartedAt,
        onCheckpoint: async (saved) => { checkpoint = saved; },
      });
      expect(result.outcome).toBe(slice === sliceScript.length - 1 ? "completed" : "yielded");
    }
  };

  const livePages = async () => (await database.query<{ external_document_id: string }>(
    "SELECT external_document_id FROM documents WHERE source_id = $1 ORDER BY external_document_id",
    [sourceId],
  )).map((row) => row.external_document_id);
  const heldPages = async () => (await database.query<{ external_document_id: string }>(
    `SELECT d.external_document_id FROM website_source_missing_pages m JOIN documents d ON d.id = m.document_id
     WHERE m.source_id = $1 AND m.decision = 'pending' ORDER BY d.external_document_id`,
    [sourceId],
  )).map((row) => row.external_document_id);

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Multi Slice Test Co", `slices-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Multi Slice Workspace", `slices-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, external_id, config, metadata)
       VALUES ($1, $2, 'website', 'docs.example', $3, '{}'::jsonb, '{}'::jsonb)`,
      [sourceId, workspaceId, site],
    );
  });

  const seedPages = async (paths: string[]) => {
    for (const path of paths) {
      await database.query(
        `INSERT INTO documents (id, workspace_id, source_id, external_document_id, title, source_content, markdown_content, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'body', 'body', 'ready', '2026-11-01T00:00:00Z')`,
        [randomUUID(), workspaceId, sourceId, externalId(path), path],
      );
    }
  };

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    audit.record.mockClear();
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("holds the pages neither slice found when they are more than a fifth of the source", async () => {
    await seedPages(["a", "b", "c", "d", "e"]);

    await crawlInSlices("scheduled", [
      { pages: [page("a"), page("b")], outcome: "yielded" },
      { pages: [page("c")], outcome: "completed", frontierExhausted: true },
    ]);

    expect(await livePages()).toEqual(["a", "b", "c", "d", "e"].map(externalId));
    expect(await heldPages()).toEqual([externalId("d"), externalId("e")]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.website_crawler.missing_pages_held",
      metadata: expect.objectContaining({ heldPageCount: 2, livePageCountBeforeCrawl: 5 }),
    }));
  });

  it("removes a fifth or less, keeping the pages only the first slice found", async () => {
    const paths = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    await seedPages(paths);

    await crawlInSlices("scheduled", [
      { pages: ["a", "b", "c", "d", "e"].map(page), outcome: "yielded" },
      { pages: ["f", "g", "h", "i", "new"].map(page), outcome: "completed", frontierExhausted: true },
    ]);

    expect(await livePages()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "new"].map(externalId));
    expect(await heldPages()).toEqual([]);
  });

  it("removes nothing when the last slice stopped with pages left to fetch", async () => {
    await seedPages(["a", "b", "c", "d", "e"]);

    await crawlInSlices("manual", [
      { pages: [page("a"), page("b")], outcome: "yielded" },
      { pages: [page("c")], outcome: "completed", frontierExhausted: false },
    ]);

    expect(await livePages()).toEqual(["a", "b", "c", "d", "e"].map(externalId));
  });

  it("removes nothing once an earlier slice dropped a link at a limit, though the last slice fetched all it found", async () => {
    await seedPages(["a", "b", "c", "d", "e"]);

    await crawlInSlices("manual", [
      { pages: [page("a"), page("b")], outcome: "yielded", droppedLinks: [`${site}/d`] },
      { pages: [page("c")], outcome: "completed", frontierExhausted: true },
    ]);

    expect(await livePages()).toEqual(["a", "b", "c", "d", "e"].map(externalId));
    expect(await heldPages()).toEqual([]);
  });

  it("removes what neither slice found after a crawl the operator started, when it is a fifth or less", async () => {
    await seedPages(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);

    await crawlInSlices("manual", [
      { pages: ["a", "b", "c", "d", "e"].map(page), outcome: "yielded" },
      { pages: ["f", "g", "h", "i"].map(page), outcome: "completed", frontierExhausted: true },
    ]);

    expect(await livePages()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(externalId));
    expect(await heldPages()).toEqual([]);
  });

  it("holds what neither slice found after a crawl the operator started, when it is more than a fifth", async () => {
    await seedPages(["a", "b", "c", "d", "e"]);

    await crawlInSlices("manual", [
      { pages: [page("a"), page("b")], outcome: "yielded" },
      { pages: [page("c")], outcome: "completed", frontierExhausted: true },
    ]);

    expect(await livePages()).toEqual(["a", "b", "c", "d", "e"].map(externalId));
    expect(await heldPages()).toEqual([externalId("d"), externalId("e")]);
  });
});
