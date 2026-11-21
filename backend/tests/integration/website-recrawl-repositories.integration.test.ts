import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { WebsiteMissingPageRepository } from "../../src/db/repositories/websiteMissingPageRepository.js";
import { WebsiteRecrawlRepository } from "../../src/db/repositories/websiteRecrawlRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("Website recrawl schedule and missing pages (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const schedule = new WebsiteRecrawlRepository(database.kysely);
  const missingPages = new WebsiteMissingPageRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const apiSourceId = randomUUID();
  const now = new Date("2026-11-21T12:00:00.000Z");

  const insertSource = async (id: string, kind: string, name: string) => {
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, external_id, config, metadata)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb)`,
      [id, workspaceId, kind, name, `${name}.example`],
    );
  };

  const insertPage = async (sourceId: string, externalDocumentId: string, createdAt = new Date("2026-11-01T00:00:00.000Z")) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO documents (id, workspace_id, source_id, external_document_id, title, source_content, markdown_content, status, created_at)
       VALUES ($1, $2, $3, $4, $4, 'body', 'body', 'ready', $5)`,
      [id, workspaceId, sourceId, externalDocumentId, createdAt],
    );
    return id;
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Recrawl Test Co", `recrawl-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Recrawl Workspace", `recrawl-route-${workspaceId}`],
    );
    await insertSource(siteId, "website", "docs");
    await insertSource(otherSiteId, "website", "help");
    await insertSource(apiSourceId, "api", "feed");
  });

  beforeEach(async () => {
    await database.query("DELETE FROM website_crawl_jobs WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
    await database.query(
      "UPDATE document_sources SET recrawl_cadence = 'off', next_recrawl_at = NULL WHERE workspace_id = $1",
      [workspaceId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("stores a website source's cadence and next recrawl, and only a website source's", async () => {
    const next = new Date("2026-11-22T12:30:00.000Z");
    await expect(schedule.setRecrawlSchedule({ workspaceId, sourceId: siteId, recrawlCadence: "daily", nextRecrawlAt: next }))
      .resolves.toMatchObject({ id: siteId, recrawlCadence: "daily", nextRecrawlAt: next });
    await expect(schedule.setRecrawlSchedule({ workspaceId, sourceId: apiSourceId, recrawlCadence: "daily", nextRecrawlAt: next }))
      .resolves.toBeNull();
    await expect(schedule.setRecrawlSchedule({ workspaceId: randomUUID(), sourceId: siteId, recrawlCadence: "weekly", nextRecrawlAt: next }))
      .resolves.toBeNull();
    await expect(schedule.setRecrawlSchedule({ workspaceId, sourceId: siteId, recrawlCadence: "off", nextRecrawlAt: null }))
      .resolves.toMatchObject({ recrawlCadence: "off", nextRecrawlAt: null });
  });

  it("claims due website sources once, advances them, and says which already have a crawl", async () => {
    const due = new Date(now.getTime() - 60_000);
    await schedule.setRecrawlSchedule({ workspaceId, sourceId: siteId, recrawlCadence: "daily", nextRecrawlAt: due });
    await schedule.setRecrawlSchedule({ workspaceId, sourceId: otherSiteId, recrawlCadence: "weekly", nextRecrawlAt: due });
    await database.query(
      `INSERT INTO website_crawl_jobs (id, workspace_id, source_id, requested_url, crawl_limit, status)
       VALUES ($1, $2, $3, 'https://help.example', 10, 'paused')`,
      [randomUUID(), workspaceId, otherSiteId],
    );
    const advancedTo = new Date("2026-11-22T12:00:00.000Z");

    const claimed = await schedule.claimDueRecrawls({ now, limit: 10, nextRecrawlAt: async () => advancedTo });

    expect(claimed.filter((source) => source.workspaceId === workspaceId)).toEqual(expect.arrayContaining([
      { workspaceId, sourceId: siteId, recrawlCadence: "daily", crawlActive: false },
      { workspaceId, sourceId: otherSiteId, recrawlCadence: "weekly", crawlActive: true },
    ]));
    const rows = await database.query<{ id: string; next_recrawl_at: Date }>(
      "SELECT id, next_recrawl_at FROM document_sources WHERE id = ANY($1::uuid[])",
      [[siteId, otherSiteId]],
    );
    expect(rows.map((row) => row.next_recrawl_at)).toEqual([advancedTo, advancedTo]);
    await expect(schedule.claimDueRecrawls({ now, limit: 10, nextRecrawlAt: async () => advancedTo }))
      .resolves.toEqual([]);
  });

  it("leaves sources that are off, not yet due, or not websites", async () => {
    await schedule.setRecrawlSchedule({ workspaceId, sourceId: siteId, recrawlCadence: "daily", nextRecrawlAt: new Date(now.getTime() + 60_000) });
    await database.query(
      "UPDATE document_sources SET recrawl_cadence = 'daily', next_recrawl_at = $2 WHERE id = $1",
      [apiSourceId, new Date(now.getTime() - 60_000)],
    );

    await expect(schedule.claimDueRecrawls({ now, limit: 10, nextRecrawlAt: async () => now })).resolves.toEqual([]);
  });

  it("gives each due source to one of two concurrent sweeps", async () => {
    const due = new Date(now.getTime() - 60_000);
    await schedule.setRecrawlSchedule({ workspaceId, sourceId: siteId, recrawlCadence: "daily", nextRecrawlAt: due });
    await schedule.setRecrawlSchedule({ workspaceId, sourceId: otherSiteId, recrawlCadence: "daily", nextRecrawlAt: due });
    const slowAdvance = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Date(now.getTime() + 86_400_000);
    };

    const [first, second] = await Promise.all([
      schedule.claimDueRecrawls({ now, limit: 10, nextRecrawlAt: slowAdvance }),
      schedule.claimDueRecrawls({ now, limit: 10, nextRecrawlAt: slowAdvance }),
    ]);

    const claimedIds = [...first, ...second].map((source) => source.sourceId).filter((id) => id === siteId || id === otherSiteId);
    expect(claimedIds.sort()).toEqual([siteId, otherSiteId].sort());
  });

  it("reviews the pages a crawl did not see, clearing the ones it saw from the held list", async () => {
    const seen = await insertPage(siteId, "page-seen");
    const gone = await insertPage(siteId, "page-gone");
    const kept = await insertPage(siteId, "page-kept");
    const reappeared = await insertPage(siteId, "page-back");
    await insertPage(siteId, "page-new", new Date("2026-11-21T12:05:00.000Z"));
    await database.query(
      `INSERT INTO website_source_missing_pages (document_id, workspace_id, source_id, decision)
       VALUES ($1, $3, $4, 'kept'), ($2, $3, $4, 'kept')`,
      [kept, reappeared, workspaceId, siteId],
    );

    const review = await missingPages.reviewMissingPages({
      workspaceId,
      sourceId: siteId,
      seenExternalDocumentIds: ["page-seen", "page-back", "page-new"],
      crawlStartedAt: now,
    });

    expect(review.livePageCountBeforeCrawl).toBe(4);
    expect(review.missingPages).toEqual(expect.arrayContaining([
      { documentId: gone, externalDocumentId: "page-gone", kept: false },
      { documentId: kept, externalDocumentId: "page-kept", kept: true },
    ]));
    expect(review.missingPages).toHaveLength(2);
    const rows = await database.query<{ document_id: string }>(
      "SELECT document_id FROM website_source_missing_pages WHERE source_id = $1",
      [siteId],
    );
    expect(rows.map((row) => row.document_id)).toEqual([kept]);
    expect(seen).toBeTruthy();
  });

  it("holds pages once, keeping when they first went missing, and keeps or counts them for the operator", async () => {
    const first = await insertPage(siteId, "page-1");
    const second = await insertPage(siteId, "page-2");
    const otherSitePage = await insertPage(otherSiteId, "page-3");

    await expect(missingPages.holdMissingPages({ workspaceId, sourceId: siteId, documentIds: [first] })).resolves.toBe(1);
    const [{ missing_since: firstMissingSince }] = await database.query<{ missing_since: Date }>(
      "SELECT missing_since FROM website_source_missing_pages WHERE document_id = $1",
      [first],
    );
    await expect(missingPages.holdMissingPages({ workspaceId, sourceId: siteId, documentIds: [first, second, otherSitePage] }))
      .resolves.toBe(1);
    const [{ missing_since: laterMissingSince }] = await database.query<{ missing_since: Date }>(
      "SELECT missing_since FROM website_source_missing_pages WHERE document_id = $1",
      [first],
    );
    expect(laterMissingSince).toEqual(firstMissingSince);

    await expect(missingPages.countHeldPages({ workspaceId, sourceIds: [siteId, otherSiteId] }))
      .resolves.toEqual(new Map([[siteId, 2]]));

    await expect(missingPages.keepHeldPages({ workspaceId, sourceId: siteId })).resolves.toBe(2);
    await expect(missingPages.countHeldPages({ workspaceId, sourceIds: [siteId] })).resolves.toEqual(new Map());
    await expect(missingPages.holdMissingPages({ workspaceId, sourceId: siteId, documentIds: [first] })).resolves.toBe(0);
    await expect(missingPages.countHeldPages({ workspaceId, sourceIds: [siteId] })).resolves.toEqual(new Map());
  });
});
