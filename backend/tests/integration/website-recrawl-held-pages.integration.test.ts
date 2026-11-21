import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { documentEventEraser } from "../../src/app/composition/workspaceEventLog.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { DocumentSourceRepository } from "../../src/db/repositories/documentSourceRepository.js";
import { WebsiteMissingPageRepository } from "../../src/db/repositories/websiteMissingPageRepository.js";
import { WebsiteHeldPagesService } from "../../src/modules/websiteCrawler/heldPagesService.js";
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
  const pageIds = Array.from({ length: 10 }, (_, index) => `page-${index}`);
  const crawlStartedAt = new Date("2026-11-21T12:00:00.000Z");

  const crawl = (trigger: "manual" | "scheduled", seenExternalDocumentIds: string[]) =>
    reconcileMissingPages(
      { store: missingPages, ingestion: { reapMissingPages: (input) => documents.deleteMissingPagesBySourceAndExternalIds(input) }, audit },
      { trigger, accountId: null, workspaceId, sourceId, seenExternalDocumentIds, crawlStartedAt },
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
  const without = (...missing: string[]) => pageIds.filter((page) => !missing.includes(page));

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

  beforeEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    for (const page of pageIds) {
      await database.query(
        `INSERT INTO documents (id, workspace_id, source_id, external_document_id, title, source_content, markdown_content, status, created_at)
         VALUES ($1, $2, $3, $4, $4, 'body', 'body', 'ready', '2026-11-01T00:00:00Z')`,
        [randomUUID(), workspaceId, sourceId, page],
      );
    }
    audit.record.mockClear();
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("removes a fifth of the pages or less on a scheduled crawl, as a manual crawl does", async () => {
    await crawl("scheduled", without("page-0", "page-1"));

    expect(await livePages()).toEqual(without("page-0", "page-1"));
    expect(await heldRows()).toEqual([]);
  });

  it("holds more than a fifth for review, then removes them when the operator says so", async () => {
    await crawl("scheduled", without("page-0", "page-1", "page-2"));

    expect(await livePages()).toEqual(pageIds);
    expect(await heldRows()).toEqual([
      { external_document_id: "page-0", decision: "pending" },
      { external_document_id: "page-1", decision: "pending" },
      { external_document_id: "page-2", decision: "pending" },
    ]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "document.website_crawler.missing_pages_held",
      metadata: expect.objectContaining({ heldPageCount: 3, livePageCountBeforeCrawl: 10 }),
    }));

    await expect(heldPages.removeHeldPages({ accountId, workspaceId, sourceId })).resolves.toEqual({ sourceId, removedPageCount: 3 });

    expect(await livePages()).toEqual(without("page-0", "page-1", "page-2"));
    expect(await heldRows()).toEqual([]);
  });

  it("keeps pages the operator kept through later scheduled crawls, until one reappears or a manual crawl runs", async () => {
    await crawl("scheduled", without("page-0", "page-1", "page-2"));
    await expect(heldPages.keepHeldPages({ accountId, workspaceId, sourceId })).resolves.toEqual({ sourceId, keptPageCount: 3 });

    await crawl("scheduled", without("page-0", "page-1", "page-2", "page-3"));
    expect(await livePages()).toEqual(without("page-3"));
    expect((await heldRows()).map((row) => row.decision)).toEqual(["kept", "kept", "kept"]);

    await crawl("scheduled", without("page-1", "page-2"));
    expect((await heldRows()).map((row) => row.external_document_id)).toEqual(["page-1", "page-2"]);

    await crawl("manual", without("page-1", "page-2"));
    expect(await livePages()).toEqual(without("page-1", "page-2", "page-3"));
    expect(await heldRows()).toEqual([]);
  });
});
