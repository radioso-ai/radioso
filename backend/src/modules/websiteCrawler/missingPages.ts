import { decideMissingPageRemoval } from "./missingPageRemoval.js";
import { buildWebsiteExternalDocumentId, normalizePageUrl, redactWebsiteCrawlerUrl } from "./pageUrls.js";
import type { CrawlTrigger } from "./recrawlSchedule.js";
import type { WebsiteCrawlerAuditPort, WebsiteCrawlerDocumentIngestionPort } from "./service.js";

/** A page of the source that a complete crawl did not find. `kept` when the operator chose to keep it. */
export interface MissingPage {
  documentId: string;
  externalDocumentId: string;
  kept: boolean;
}

export interface MissingPageReview {
  /**
   * The source's pages that existed before the crawl started, less the ones the operator kept: the
   * share a removal is measured against.
   */
  livePageCountBeforeCrawl: number;
  missingPages: MissingPage[];
}

/** What a crawl reads and writes about the pages it no longer finds. */
export interface WebsiteMissingPageStore {
  /** Clears the pages the crawl saw from the held list, then lists the source's pages it did not see. */
  reviewMissingPages(input: {
    workspaceId: string;
    sourceId: string;
    seenExternalDocumentIds: readonly string[];
    crawlStartedAt: Date;
  }): Promise<MissingPageReview>;
  /** Holds pages for the operator. A page already held keeps the time it first went missing. Returns how many are newly held. */
  holdMissingPages(input: { workspaceId: string; sourceId: string; documentIds: readonly string[] }): Promise<number>;
}

/** What the operator's decision on held pages reads and writes. */
export interface WebsiteHeldPageStore {
  /** Marks the source's held pages kept; returns how many. */
  keepHeldPages(input: { workspaceId: string; sourceId: string }): Promise<number>;
  /** Held pages per source, for the sources that have any. */
  countHeldPages(input: { workspaceId: string; sourceIds: readonly string[] }): Promise<Map<string, number>>;
}

export const MISSING_PAGES_HELD_AUDIT_EVENT = "document.website_crawler.missing_pages_held";

/**
 * The external ids of every page a crawl saw across all of its slices: the ids it published, and
 * each canonical URL its checkpoint records as processed, built exactly as ingestion builds a
 * page's id. A page skipped as duplicate content or by policy is processed, so it counts as seen and
 * is never removed for being skipped.
 */
export const pagesSeenByCrawl = (input: {
  websiteBaseUrl: string;
  processedCanonicalUrls: Iterable<string>;
  publishedExternalDocumentIds: readonly string[];
}): string[] => {
  const seen = new Set(input.publishedExternalDocumentIds);
  for (const canonicalUrl of input.processedCanonicalUrls) {
    try {
      seen.add(buildWebsiteExternalDocumentId({
        websiteBaseUrl: input.websiteBaseUrl,
        pageUrl: redactWebsiteCrawlerUrl(normalizePageUrl(canonicalUrl)),
      }));
    } catch {
      // An address the crawler cannot read names no page it published.
    }
  }
  return [...seen];
};

/**
 * Removes the pages a complete crawl no longer found, or holds them for the operator. A crawl the
 * operator started removes every page it did not see. A scheduled crawl leaves pages the operator
 * kept, and holds the rest instead when they are too large a share of the source
 * ({@link decideMissingPageRemoval}).
 */
export const reconcileMissingPages = async (
  dependencies: {
    store?: WebsiteMissingPageStore;
    ingestion: Pick<WebsiteCrawlerDocumentIngestionPort, "reapMissingPages">;
    audit?: WebsiteCrawlerAuditPort;
  },
  input: {
    trigger: CrawlTrigger;
    accountId?: string | null;
    workspaceId: string;
    sourceId: string;
    seenExternalDocumentIds: string[];
    crawlStartedAt: Date;
  },
): Promise<void> => {
  if (!dependencies.ingestion.reapMissingPages) {
    return;
  }
  const remove = async (keepExternalDocumentIds: string[]) => {
    await dependencies.ingestion.reapMissingPages?.({ workspaceId: input.workspaceId, sourceId: input.sourceId, keepExternalDocumentIds });
  };
  if (!dependencies.store) {
    // Without a store a scheduled crawl cannot tell how much it would remove, so it removes nothing.
    if (input.trigger === "manual") await remove(input.seenExternalDocumentIds);
    return;
  }
  const review = await dependencies.store.reviewMissingPages(input);
  if (input.trigger === "manual") {
    await remove(input.seenExternalDocumentIds);
    return;
  }
  const candidates = review.missingPages.filter((page) => !page.kept);
  if (candidates.length === 0) {
    return;
  }
  const decision = decideMissingPageRemoval({
    trigger: input.trigger,
    missingPageCount: candidates.length,
    livePageCountBeforeCrawl: review.livePageCountBeforeCrawl,
  });
  if (decision === "remove") {
    const kept = review.missingPages.filter((page) => page.kept).map((page) => page.externalDocumentId);
    await remove([...input.seenExternalDocumentIds, ...kept]);
    return;
  }
  const newlyHeldPageCount = await dependencies.store.holdMissingPages({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    documentIds: candidates.map((page) => page.documentId),
  });
  await dependencies.audit?.record({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: MISSING_PAGES_HELD_AUDIT_EVENT,
    eventStatus: "success",
    metadata: {
      sourceId: input.sourceId,
      heldPageCount: candidates.length,
      newlyHeldPageCount,
      livePageCountBeforeCrawl: review.livePageCountBeforeCrawl,
    },
  });
};
