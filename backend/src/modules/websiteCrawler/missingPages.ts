import { decideMissingPageRemoval } from "./missingPageRemoval.js";
import {
  decideVerifiedRemoval,
  MAX_VERIFIED_MISSING_PAGES,
  verifyMissingPages,
  type WebsitePageProbe,
} from "./missingPageVerification.js";
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
  /** The address the page was published under, as ingestion stored it; null when it has none. */
  pageUrl: string | null;
  kept: boolean;
}

/** What one reconciliation did with the missing pages it was not told to keep. Counts only, safe to log. */
export interface MissingPageCounts {
  candidates: number;
  held: number;
  gone: number;
  alive: number;
  unknown: number;
  removed: number;
  /** More were missing than one crawl verifies, so it asked about and removed none. */
  overVerificationBound: boolean;
}

type MissingPageReconciliation =
  | { status: "reconciled"; counts: MissingPageCounts }
  /** Nothing to measure a removal against, so nothing was reviewed. */
  | { status: "skipped" }
  /** A newer crawl of the source exists; what this one saw is older than what it publishes. */
  | { status: "superseded" };

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
 * them when they are too large a share of the source ({@link decideMissingPageRemoval}). Before it
 * removes a page it asks the site, and removes only the pages the site says are gone. A crawl that
 * a newer crawl of the source superseded does neither.
 */
export const reconcileMissingPages = async (
  dependencies: MissingPageReconciliationDependencies,
  input: CompleteCrawl & {
    /** Whether the crawl is still the newest of the source's crawls, asked before anything is removed or held. */
    isNewestCrawlOfSource?: () => Promise<boolean>;
    /** Stops asking the site when the crawl is cancelled. */
    signal?: AbortSignal;
  },
): Promise<MissingPageReconciliation> => {
  const { isNewestCrawlOfSource, ...crawl } = input;
  // Without a store a crawl cannot tell how much it would remove, so it removes nothing.
  if (!dependencies.ingestion.reapMissingPages || !dependencies.store) {
    return { status: "skipped" };
  }
  if (isNewestCrawlOfSource && !(await isNewestCrawlOfSource())) {
    return { status: "superseded" };
  }
  return { status: "reconciled", counts: await removeOrHoldMissingPages({ ...dependencies, store: dependencies.store }, crawl) };
};

interface MissingPageReconciliationDependencies {
  store?: WebsiteMissingPageStore;
  ingestion: Pick<WebsiteCrawlerDocumentIngestionPort, "reapMissingPages">;
  audit?: WebsiteCrawlerAuditPort;
  /** Asks the site whether a page is gone. Without one no page is confirmed gone, so none is removed. */
  probe?: WebsitePageProbe;
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

const removeOrHoldMissingPages = async (
  dependencies: MissingPageReconciliationDependencies & { store: WebsiteMissingPageStore },
  input: CompleteCrawl & { signal?: AbortSignal },
): Promise<MissingPageCounts> => {
  const review = await dependencies.store.reviewMissingPages({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    externalDocumentIdPrefix: websiteExternalDocumentIdPrefix(input.websiteBaseUrl),
    seenExternalDocumentIds: input.seenExternalDocumentIds,
    crawlStartedAt: input.crawlStartedAt,
  });
  const candidates = review.missingPages.filter((page) => !page.kept);
  const counts: MissingPageCounts = {
    candidates: candidates.length, held: 0, gone: 0, alive: 0, unknown: 0, removed: 0, overVerificationBound: false,
  };
  if (candidates.length === 0) {
    return counts;
  }
  const decision = decideMissingPageRemoval({
    missingPageCount: candidates.length,
    livePageCountBeforeCrawl: review.livePageCountBeforeCrawl,
  });
  if (decision === "remove") {
    return removeVerifiedGonePages(dependencies, input, candidates, counts);
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
  return { ...counts, held: candidates.length };
};

/** Asks the site about each page and removes the ones it says are gone; past the bound, asks about and removes none. */
const removeVerifiedGonePages = async (
  dependencies: MissingPageReconciliationDependencies,
  input: CompleteCrawl & { signal?: AbortSignal },
  candidates: MissingPage[],
  counts: MissingPageCounts,
): Promise<MissingPageCounts> => {
  if (candidates.length > MAX_VERIFIED_MISSING_PAGES) {
    return { ...counts, unknown: candidates.length, overVerificationBound: true };
  }
  const verdicts = await verifyMissingPages(dependencies.probe, {
    websiteBaseUrl: input.websiteBaseUrl,
    pages: candidates,
    signal: input.signal,
  });
  const { removeDocumentIds, ...verified } = decideVerifiedRemoval(verdicts);
  if (removeDocumentIds.length === 0) {
    return { ...counts, ...verified };
  }
  const removal = await dependencies.ingestion.reapMissingPages?.({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    documentIds: removeDocumentIds,
  });
  return { ...counts, ...verified, removed: removal?.deletedCount ?? 0 };
};
