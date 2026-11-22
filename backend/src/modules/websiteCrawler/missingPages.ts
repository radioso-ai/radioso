import { decideMissingPageRemoval } from "./missingPageRemoval.js";
import {
  buildWebsiteExternalDocumentId,
  normalizePageUrl,
  redactWebsiteCrawlerUrl,
  websiteExternalDocumentIdPrefix,
} from "./pageUrls.js";
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
  /**
   * Clears the pages the crawl saw from the held list, then lists the pages it did not see among the
   * ones a crawl of its site published (their external id starts with `externalDocumentIdPrefix`)
   * before it started. A page anything else put in the source is never missing.
   */
  reviewMissingPages(input: {
    workspaceId: string;
    sourceId: string;
    externalDocumentIdPrefix: string;
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
 * Whether a finished crawl saw the whole site within its scope, so that a page it did not see is
 * gone rather than unreached. Only then may it remove or hold missing pages. The crawl's last
 * slice must have stopped because nothing was left to fetch, no slice may have dropped a link at a
 * limit or failed to read a sitemap, no page may have failed, and the checkpoint it resumed from
 * must list every URL.
 */
export const crawlSawWholeSite = (crawl: {
  status: string | null;
  failedPageCount: number;
  frontierExhausted: boolean;
  linksDroppedAtLimit: boolean;
  sitemapUnread: boolean;
  resumedCheckpointListsEveryUrl: boolean;
}): boolean =>
  crawl.status === "completed" &&
  crawl.failedPageCount === 0 &&
  crawl.frontierExhausted &&
  !crawl.linksDroppedAtLimit &&
  !crawl.sitemapUnread &&
  crawl.resumedCheckpointListsEveryUrl;

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
 * Removes the pages a complete crawl no longer found, or holds them for the operator, whatever
 * started the crawl. It leaves pages the operator kept, and holds the rest instead of removing
 * them when they are too large a share of the source ({@link decideMissingPageRemoval}). A crawl that a newer crawl of the source superseded does
 * neither: what it saw is older than what the newer crawl publishes.
 */
export const reconcileMissingPages = async (
  dependencies: MissingPageReconciliationDependencies,
  input: CompleteCrawl & {
    /** Whether the crawl is still the newest of the source's crawls, asked before anything is removed or held. */
    isNewestCrawlOfSource?: () => Promise<boolean>;
  },
): Promise<"reconciled" | "superseded"> => {
  const { isNewestCrawlOfSource, ...crawl } = input;
  if (!dependencies.ingestion.reapMissingPages) {
    return "reconciled";
  }
  if (isNewestCrawlOfSource && !(await isNewestCrawlOfSource())) {
    return "superseded";
  }
  await removeOrHoldMissingPages(dependencies, crawl);
  return "reconciled";
};

interface MissingPageReconciliationDependencies {
  store?: WebsiteMissingPageStore;
  ingestion: Pick<WebsiteCrawlerDocumentIngestionPort, "reapMissingPages">;
  audit?: WebsiteCrawlerAuditPort;
}

/** A crawl that saw the whole site ({@link crawlSawWholeSite}), and every page it saw. */
interface CompleteCrawl {
  accountId?: string | null;
  workspaceId: string;
  sourceId: string;
  /** The site the crawl published its pages under; only those pages can go missing. */
  websiteBaseUrl: string;
  seenExternalDocumentIds: string[];
  crawlStartedAt: Date;
}

const removeOrHoldMissingPages = async (dependencies: MissingPageReconciliationDependencies, input: CompleteCrawl): Promise<void> => {
  if (!dependencies.store) {
    // Without a store a crawl cannot tell how much it would remove, so it removes nothing.
    return;
  }
  const review = await dependencies.store.reviewMissingPages({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    externalDocumentIdPrefix: websiteExternalDocumentIdPrefix(input.websiteBaseUrl),
    seenExternalDocumentIds: input.seenExternalDocumentIds,
    crawlStartedAt: input.crawlStartedAt,
  });
  const candidates = review.missingPages.filter((page) => !page.kept);
  if (candidates.length === 0) {
    return;
  }
  const decision = decideMissingPageRemoval({
    missingPageCount: candidates.length,
    livePageCountBeforeCrawl: review.livePageCountBeforeCrawl,
  });
  if (decision === "remove") {
    await dependencies.ingestion.reapMissingPages?.({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      documentIds: candidates.map((page) => page.documentId),
    });
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
