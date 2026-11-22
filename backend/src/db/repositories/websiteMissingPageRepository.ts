import { sql } from "kysely";

import type {
  MissingPageReview,
  WebsiteHeldPageStore,
  WebsiteMissingPageStore,
} from "../../modules/websiteCrawler/missingPages.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * `website_source_missing_pages`: pages a crawl found missing and held for the operator
 * (`pending`), or that the operator chose to keep (`kept`). A row goes with its document.
 */
export class WebsiteMissingPageRepository implements WebsiteMissingPageStore, WebsiteHeldPageStore {
  constructor(private readonly db: Db) {}

  async reviewMissingPages(input: {
    workspaceId: string;
    sourceId: string;
    externalDocumentIdPrefix: string;
    seenExternalDocumentIds: readonly string[];
    crawlStartedAt: Date;
  }): Promise<MissingPageReview> {
    // starts_with, not LIKE: a site's address is full of `_`, which LIKE reads as a wildcard.
    const publishedByThisSite = sql<boolean>`starts_with(d.external_document_id, ${input.externalDocumentIdPrefix})`;
    const seen = [...new Set(input.seenExternalDocumentIds.filter((id) => id.length > 0))];
    return this.db.transaction().execute(async (trx) => {
      if (seen.length > 0) {
        await trx
          .deleteFrom("website_source_missing_pages as m")
          .using("documents as d")
          .whereRef("d.id", "=", "m.document_id")
          .where("m.workspace_id", "=", input.workspaceId)
          .where("m.source_id", "=", input.sourceId)
          .where(sql<boolean>`d.external_document_id = ANY(${sql.val(seen)}::text[])`)
          .execute();
      }
      const missing = await trx
        .selectFrom("documents as d")
        .leftJoin("website_source_missing_pages as m", "m.document_id", "d.id")
        .select(["d.id", "d.external_document_id", "m.decision"])
        // The address the page was published under, as ingestion wrote it into the document's metadata.
        .select(sql<string | null>`coalesce(d.metadata->>'canonicalUrl', d.metadata->>'sourceUrl')`.as("page_url"))
        .where("d.workspace_id", "=", input.workspaceId)
        .where("d.source_id", "=", input.sourceId)
        .where(publishedByThisSite)
        .where("d.created_at", "<", input.crawlStartedAt)
        .where(sql<boolean>`d.external_document_id <> ALL(${sql.val(seen)}::text[])`)
        .orderBy("d.external_document_id")
        .execute();
      // Kept pages stay out of the count: they never leave, so they would make every removal look smaller.
      const live = await trx
        .selectFrom("documents as d")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("d.workspace_id", "=", input.workspaceId)
        .where("d.source_id", "=", input.sourceId)
        .where(publishedByThisSite)
        .where("d.created_at", "<", input.crawlStartedAt)
        .where((eb) => eb.not(eb.exists(
          eb.selectFrom("website_source_missing_pages as k").select("k.document_id")
            .whereRef("k.document_id", "=", "d.id").where("k.decision", "=", "kept"),
        )))
        .executeTakeFirstOrThrow();
      return {
        livePageCountBeforeCrawl: Number(live.count),
        missingPages: missing.map((row) => ({
          documentId: row.id,
          externalDocumentId: row.external_document_id ?? "",
          pageUrl: row.page_url,
          kept: row.decision === "kept",
        })),
      };
    });
  }

  async holdMissingPages(input: { workspaceId: string; sourceId: string; documentIds: readonly string[] }): Promise<number> {
    if (input.documentIds.length === 0) {
      return 0;
    }
    const result = await this.db
      .insertInto("website_source_missing_pages")
      .columns(["document_id", "workspace_id", "source_id"])
      .expression((eb) =>
        eb
          .selectFrom("documents")
          .select(["id", "workspace_id", "source_id"])
          .where("workspace_id", "=", input.workspaceId)
          .where("source_id", "=", input.sourceId)
          .where("id", "in", [...input.documentIds]),
      )
      .onConflict((oc) => oc.column("document_id").doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0);
  }

  async keepHeldPages(input: { workspaceId: string; sourceId: string }): Promise<number> {
    const result = await this.db
      .updateTable("website_source_missing_pages")
      .set({ decision: "kept", decided_at: currentTimestamp() })
      .where("workspace_id", "=", input.workspaceId)
      .where("source_id", "=", input.sourceId)
      .where("decision", "=", "pending")
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async countHeldPages(input: { workspaceId: string; sourceIds: readonly string[] }): Promise<Map<string, number>> {
    if (input.sourceIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom("website_source_missing_pages")
      .select(["source_id", (eb) => eb.fn.countAll<string>().as("count")])
      .where("workspace_id", "=", input.workspaceId)
      .where("source_id", "in", [...input.sourceIds])
      .where("decision", "=", "pending")
      .groupBy("source_id")
      .execute();
    return new Map(rows.map((row) => [row.source_id, Number(row.count)]));
  }
}
