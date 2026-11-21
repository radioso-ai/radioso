import type { ActiveRecrawlCadence, RecrawlCadence } from "../../modules/websiteCrawler/public.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  documentSourceColumns,
  mapDocumentSource,
  type DocumentSourceRecord,
  type DocumentSourceRow,
} from "./documentSourceRepository.js";

/** A website source the sweep claimed. `crawlActive` when it already has a crawl queued, running or paused. */
export interface DueWebsiteRecrawl {
  workspaceId: string;
  sourceId: string;
  recrawlCadence: ActiveRecrawlCadence;
  crawlActive: boolean;
}

export interface WebsiteRecrawlRepositoryPort {
  /** Null when the source is not one of the workspace's website sources. */
  setRecrawlSchedule(input: {
    workspaceId: string;
    sourceId: string;
    recrawlCadence: RecrawlCadence;
    nextRecrawlAt: Date | null;
  }): Promise<DocumentSourceRecord | null>;
  /**
   * Claims up to `limit` website sources whose next recrawl is due and moves each to the time
   * `nextRecrawlAt` returns, in one transaction. Sources another sweep holds are skipped, so
   * concurrent sweeps claim disjoint sets. `nextRecrawlAt` runs inside the transaction, so a throw
   * from it rolls back the whole batch.
   */
  claimDueRecrawls(input: {
    now: Date;
    limit: number;
    nextRecrawlAt: (source: DueWebsiteRecrawl) => Promise<Date>;
  }): Promise<DueWebsiteRecrawl[]>;
}

const UNFINISHED_CRAWL_STATUSES = ["queued", "processing", "paused"];

export class WebsiteRecrawlRepository implements WebsiteRecrawlRepositoryPort {
  constructor(private readonly db: Db) {}

  async setRecrawlSchedule(input: {
    workspaceId: string;
    sourceId: string;
    recrawlCadence: RecrawlCadence;
    nextRecrawlAt: Date | null;
  }): Promise<DocumentSourceRecord | null> {
    const row = await this.db
      .updateTable("document_sources")
      .set({ recrawl_cadence: input.recrawlCadence, next_recrawl_at: input.nextRecrawlAt, updated_at: currentTimestamp() })
      .where("id", "=", input.sourceId)
      .where("workspace_id", "=", input.workspaceId)
      .where("kind", "=", "website")
      .returning(documentSourceColumns)
      .executeTakeFirst();
    return row ? mapDocumentSource(row as DocumentSourceRow) : null;
  }

  async claimDueRecrawls(input: {
    now: Date;
    limit: number;
    nextRecrawlAt: (source: DueWebsiteRecrawl) => Promise<Date>;
  }): Promise<DueWebsiteRecrawl[]> {
    return this.db.transaction().execute(async (trx) => {
      // The predicate matches idx_document_sources_due_recrawl, so the scan reads due rows only.
      const rows = await trx
        .selectFrom("document_sources as s")
        .select((eb) => [
          "s.id",
          "s.workspace_id",
          "s.recrawl_cadence",
          eb.exists(
            eb.selectFrom("website_crawl_jobs as j")
              .select("j.id")
              .whereRef("j.source_id", "=", "s.id")
              .whereRef("j.workspace_id", "=", "s.workspace_id")
              .where("j.status", "in", UNFINISHED_CRAWL_STATUSES),
          ).as("crawl_active"),
        ])
        .where("s.kind", "=", "website")
        .where("s.recrawl_cadence", "<>", "off")
        .where("s.next_recrawl_at", "<=", input.now)
        .orderBy("s.next_recrawl_at", "asc")
        .limit(input.limit)
        .forUpdate("s")
        .skipLocked()
        .execute();
      const claimed: DueWebsiteRecrawl[] = [];
      for (const row of rows) {
        const source: DueWebsiteRecrawl = {
          workspaceId: row.workspace_id,
          sourceId: row.id,
          // The claim excludes `off`, and the column's CHECK admits only these values.
          recrawlCadence: row.recrawl_cadence === "daily" ? "daily" : "weekly",
          crawlActive: Boolean(row.crawl_active),
        };
        await trx
          .updateTable("document_sources")
          .set({ next_recrawl_at: await input.nextRecrawlAt(source) })
          .where("id", "=", row.id)
          .execute();
        claimed.push(source);
      }
      return claimed;
    });
  }
}
