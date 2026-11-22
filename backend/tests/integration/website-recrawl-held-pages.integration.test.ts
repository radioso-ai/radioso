import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { documentEventEraser } from "../../src/app/composition/workspaceEventLog.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../src/db/repositories/documentSourceRepository.js";
import { WebsiteMissingPageRepository } from "../../src/db/repositories/websiteMissingPageRepository.js";
import { WebsiteHeldPagesService } from "../../src/modules/websiteCrawler/heldPagesService.js";
import { MAX_VERIFIED_MISSING_PAGES, type WebsitePageAnswer } from "../../src/modules/websiteCrawler/missingPageVerification.js";
import { reconcileMissingPages } from "../../src/modules/websiteCrawler/missingPages.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("Scheduled recrawl holds, removes and keeps missing pages (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const documents = new DocumentRepository(database.kysely, documentEventEraser);
  const missingPages = new WebsiteMissingPageRepository(database.kysely);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const heldPages = new WebsiteHeldPagesService({
    sources: new DocumentSourceRepository(database.kysely),
    heldPages: missingPages,
    pages: { removeHeldPages: (removal) => documents.deleteHeldSourcePages(removal) },
    audit,
  });

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const sourceId = randomUUID();
  const site = "https://docs.example";
  const pageId = (path: string) => `website:${site}:${site}/${path}`;
  const pageIds = Array.from({ length: 10 }, (_, index) => pageId(`page-${index}`));
  const crawlStartedAt = new Date("2026-11-21T12:00:00.000Z");

  // What the site answers for each address it is asked about; a page it does not list is 404.
  let siteAnswers = new Map<string, WebsitePageAnswer>();
  const probe = {
    probePages: vi.fn(async (urls: readonly string[]) =>
      urls.map((url) => siteAnswers.get(url) ?? { kind: "answered" as const, status: 404, url })),
  };

  const crawl = (seenExternalDocumentIds: string[]) =>
    reconcileMissingPages(
      { store: missingPages, ingestion: { reapMissingPages: (input) => documents.deleteMissingSourcePages(input) }, audit, probe },
      { accountId: null, workspaceId, sourceId, websiteBaseUrl: site, seenExternalDocumentIds, crawlStartedAt },
    );
  const livePages = async () => {
    const rows = await database.query<{ external_document_id: string }>(
      "SELECT external_document_id FROM documents WHERE source_id = $1 ORDER BY external_document_id",
      [sourceId],
    );
    return rows.map((row) => row.external_document_id);
  };
  const heldRows = async () => database.query<{ external_document_id: string; decision: string }>(
    `SELECT d.external_document_id, m.decision FROM website_source_missing_pages m
     JOIN documents d ON d.id = m.document_id WHERE m.source_id = $1 ORDER BY d.external_document_id`,
    [sourceId],
  );
  const without = (...missing: string[]) => pageIds.filter((page) => !missing.map(pageId).includes(page));

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Held Pages Test Co", `held-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Held Pages Workspace", `held-route-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, external_id, config, metadata, recrawl_cadence)
       VALUES ($1, $2, 'website', 'docs.example', 'https://docs.example', '{}'::jsonb, '{}'::jsonb, 'weekly')`,
      [sourceId, workspaceId],
    );
  });

  /** Pages a crawl of the site published, each under the address its id names. */
  const seedCrawledPages = async (paths: string[]) => {
    await database.query(
      `INSERT INTO documents (id, workspace_id, source_id, external_document_id, title, source_content, markdown_content, status, created_at, metadata)
       SELECT gen_random_uuid(), $1, $2, 'website:' || $3 || ':' || $3 || '/' || path, path, 'body', 'body', 'ready', '2026-11-01T00:00:00Z',
              jsonb_build_object('sourceUrl', $3 || '/' || path, 'canonicalUrl', $3 || '/' || path)
       FROM unnest($4::text[]) AS path`,
      [workspaceId, sourceId, site, paths],
    );
  };

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    await seedCrawledPages(Array.from({ length: 10 }, (_, index) => `page-${index}`));
    siteAnswers = new Map();
    probe.probePages.mockClear();
    audit.record.mockClear();
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("removes a fifth of the pages or less", async () => {
    await crawl(without("page-0", "page-1"));

    expect(await livePages()).toEqual(without("page-0", "page-1"));
    expect(await heldRows()).toEqual([]);
  });

  it("removes only the missing pages the site says are gone, and leaves one that still answers", async () => {
    siteAnswers.set(`${site}/page-1`, { kind: "answered", status: 200, url: `${site}/page-1` });

    const reconciliation = await crawl(without("page-0", "page-1"));

    expect(probe.probePages).toHaveBeenCalledWith([`${site}/page-0`, `${site}/page-1`], expect.anything());
    expect(await livePages()).toEqual(without("page-0"));
    expect(reconciliation).toMatchObject({ counts: { candidates: 2, gone: 1, alive: 1, unknown: 0, removed: 1 } });
  });

  it("removes none when more pages are missing than one crawl verifies", async () => {
    const many = Array.from({ length: MAX_VERIFIED_MISSING_PAGES + 1 }, (_, index) => `extra-${index}`);
    // Enough pages that the missing ones are still a fifth of the source or less.
    await seedCrawledPages([...many, ...Array.from({ length: many.length * 4 - pageIds.length }, (_, index) => `seen-${index}`)]);
    const seen = (await database.query<{ external_document_id: string }>(
      "SELECT external_document_id FROM documents WHERE source_id = $1 AND external_document_id NOT LIKE '%/extra-%'",
      [sourceId],
    )).map((row) => row.external_document_id);

    const reconciliation = await crawl(seen);

    expect(probe.probePages).not.toHaveBeenCalled();
    expect(reconciliation).toMatchObject({ counts: { candidates: many.length, held: 0, removed: 0, overVerificationBound: true } });
    expect((await livePages()).filter((id) => id.includes("/extra-"))).toHaveLength(many.length);
    expect(await heldRows()).toEqual([]);
  });

  it("never removes a page of the source that no crawl of the site published", async () => {
    const reviewedImport = "reviewed-import:opening-hours";
    await database.query(
      `INSERT INTO documents (id, workspace_id, source_id, external_document_id, title, source_content, markdown_content, status, created_at)
       VALUES ($1, $2, $3, $4, $4, 'body', 'body', 'ready', '2026-11-01T00:00:00Z')`,
      [randomUUID(), workspaceId, sourceId, reviewedImport],
    );

    await crawl(without("page-0"));

    expect(await livePages()).toEqual([...without("page-0"), reviewedImport].sort());
    expect(await heldRows()).toEqual([]);
  });

  it("holds more than a fifth for review, then removes them when the operator says so", async () => {
    await crawl(without("page-0", "page-1", "page-2"));

    expect(await livePages()).toEqual(pageIds);
    expect(await heldRows()).toEqual([
      { external_document_id: pageId("page-0"), decision: "pending" },
      { external_document_id: pageId("page-1"), decision: "pending" },
      { external_document_id: pageId("page-2"), decision: "pending" },
    ]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.website_crawler.missing_pages_held",
      metadata: expect.objectContaining({ heldPageCount: 3, livePageCountBeforeCrawl: 10 }),
    }));

    await expect(heldPages.removeHeldPages({ accountId, workspaceId, sourceId })).resolves.toEqual({ sourceId, removedPageCount: 3 });

    expect(await livePages()).toEqual(without("page-0", "page-1", "page-2"));
    expect(await heldRows()).toEqual([]);
  });

  it("keeps pages the operator kept through later crawls, until one reappears", async () => {
    await crawl(without("page-0", "page-1", "page-2"));
    await expect(heldPages.keepHeldPages({ accountId, workspaceId, sourceId })).resolves.toEqual({ sourceId, keptPageCount: 3 });

    await crawl(without("page-0", "page-1", "page-2", "page-3"));
    expect(await livePages()).toEqual(without("page-3"));
    expect((await heldRows()).map((row) => row.decision)).toEqual(["kept", "kept", "kept"]);

    await crawl(without("page-1", "page-2"));
    expect((await heldRows()).map((row) => row.external_document_id)).toEqual([pageId("page-1"), pageId("page-2")]);

    await crawl(without("page-1", "page-2"));
    expect(await livePages()).toEqual(without("page-3"));
    expect((await heldRows()).map((row) => row.decision)).toEqual(["kept", "kept"]);
  });
});
