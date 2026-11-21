import type { DocumentSourceRepositoryPort } from "../../db/repositories/documentSourceRepository.js";
import type { WebsiteHeldPageStore } from "./missingPages.js";
import { requireWebsiteSource } from "./recrawlScheduleService.js";
import type { WebsiteCrawlerAuditPort } from "./service.js";

/**
 * Deletes the source's held pages the way the crawl's own removal deletes pages. It deletes the
 * pages still held when it runs, in one step, so a page a crawl saw again in the meantime stays.
 * The documents module implements it.
 */
export interface WebsiteSourcePageRemovalPort {
  removeHeldPages(input: { workspaceId: string; sourceId: string }): Promise<{ deletedCount: number }>;
}

/** The operator's decision on the pages a scheduled crawl held: remove them, or keep them for good. */
export class WebsiteHeldPagesService {
  constructor(private readonly dependencies: {
    sources: Pick<DocumentSourceRepositoryPort, "findByIdAndWorkspaceId">;
    heldPages: Pick<WebsiteHeldPageStore, "keepHeldPages">;
    pages: WebsiteSourcePageRemovalPort;
    audit: WebsiteCrawlerAuditPort;
  }) {}

  /** Deletes the held pages; their held rows go with them. */
  async removeHeldPages(input: { accountId: string; workspaceId: string; sourceId: string }): Promise<{ sourceId: string; removedPageCount: number }> {
    await requireWebsiteSource(this.dependencies.sources, input);
    const { deletedCount } = await this.dependencies.pages.removeHeldPages({ workspaceId: input.workspaceId, sourceId: input.sourceId });
    if (deletedCount > 0) {
      await this.audit("document.website_crawler.held_pages_removed", input, deletedCount);
    }
    return { sourceId: input.sourceId, removedPageCount: deletedCount };
  }

  /** Keeps the held pages. A later scheduled crawl neither holds nor removes them. */
  async keepHeldPages(input: { accountId: string; workspaceId: string; sourceId: string }): Promise<{ sourceId: string; keptPageCount: number }> {
    await requireWebsiteSource(this.dependencies.sources, input);
    const keptPageCount = await this.dependencies.heldPages.keepHeldPages({ workspaceId: input.workspaceId, sourceId: input.sourceId });
    if (keptPageCount > 0) {
      await this.audit("document.website_crawler.held_pages_kept", input, keptPageCount);
    }
    return { sourceId: input.sourceId, keptPageCount };
  }

  private async audit(eventType: string, input: { accountId: string; workspaceId: string; sourceId: string }, pageCount: number): Promise<void> {
    await this.dependencies.audit.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType,
      eventStatus: "success",
      metadata: { sourceId: input.sourceId, pageCount },
    });
  }
}
