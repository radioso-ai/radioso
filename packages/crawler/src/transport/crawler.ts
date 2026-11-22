import {
  BasicCrawler,
  Configuration,
  LogLevel,
  MemoryStorage,
  RobotsTxtFile,
  log
} from "crawlee";
import type { CrawlCandidateDecision } from "./candidateDecision.js";
import type { PageImage } from "./htmlImageExtraction.js";
import { matchesUrlPattern } from "./urlPatterns.js";
import {
  buildAcceptedCandidateDecision,
  buildRejectedCandidateDecision
} from "./candidateDecision.js";
import { canonicalizeUrlIdentity, classifyCrawlCandidateUrl } from "./url.js";
import {
  ensureSystemBinaryPaths,
  fetchPageWithCrawlee,
  fetchText,
  normalizeSameOriginFetchUrl,
  parseSitemapUrls,
  readErrorMetadata,
  toOriginScopeUrl,
  unique,
} from "./pageFetchTransport.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FetchedPage = {
  url: string;
  title: string | null;
  text: string;
  html: string;
  httpStatus: number | null;
  links: string[];
  parsedData?: JsonValue | null;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  transportUsed?: "http" | "browser";
  httpAttempted?: boolean;
  browserAttempted?: boolean;
  browserFallbackReason?: "http_error" | "incomplete_http" | "low_quality" | null;
  httpQualityScore?: number | null;
  pageType?: "content" | "listing" | "asset" | "feed" | "search" | "unknown";
  qualityScore?: number | null;
  skipReason?: string | null;
  extractedContainer?: string | null;
  normalizedContentHash?: string | null;
  /** The page's metadata picture and the images inside its main content, by address only. */
  images?: PageImage[];
};

export type ValidateNavigationUrl = (url: string) => Promise<void> | void;

export type CrawledPageResult = FetchedPage & {
  frontierUrl: string;
  status: "success" | "failed" | "unchanged";
  error?: string | null;
};

export type FetchPage = (
  url: string,
  options?: {
    etag?: string | null;
    lastModified?: string | null;
    scopeBaseUrl?: string | null;
    userAgent?: string;
    preserveContentLinks?: boolean;
    validateNavigationUrl?: ValidateNavigationUrl;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }
) => Promise<FetchedPage>;

type CrawlSiteParams = {
  baseUrl: string;
  /** The most requests this run makes. */
  pageLimit: number;
  /**
   * The whole crawl's page limit when this run continues it from `seedDiscoveredUrls`. The
   * discovery limit is sized from it, because the URLs earlier runs discovered count against it.
   * Defaults to `pageLimit`.
   */
  totalPageLimit?: number;
  pageConcurrency?: number;
  userAgent?: string;
  includeUrlPatterns?: string[];
  excludeUrlPatterns?: string[];
  preserveContentLinks?: boolean;
  seedDiscoveredUrls?: string[];
  seedPendingUrls?: string[];
  includeBaseUrl?: boolean;
  fetchPage?: FetchPage;
  validateNavigationUrl?: ValidateNavigationUrl;
  fetchImpl?: typeof fetch;
  getPageMetadata?: (
    url: string
  ) => Promise<{ etag?: string | null; lastModified?: string | null } | null>;
  onDiscoveredUrl?: (url: string) => void | Promise<void>;
  /**
   * Called once when the run cannot read the site's robots.txt or a sitemap it lists, so pages only
   * a sitemap names may be unknown to it. The run is then not exhausted.
   */
  onSitemapUnread?: () => void | Promise<void>;
  /**
   * The longest one page may take, from its fetch to the end of `onResult`. A page that takes
   * longer is not fetched again, and leaves the run not exhausted. Defaults to
   * {@link DEFAULT_PAGE_TIMEOUT_SECS}.
   */
  pageTimeoutSecs?: number;
  onCandidateUrl?: (
    decision: CrawlCandidateDecision & { sourcePageUrl: string }
  ) => void | Promise<void>;
  onPage?: (page: {
    url: string;
    status: "success" | "failed" | "unchanged";
  }) => void | Promise<void>;
  resolvePolicy?: (rawUrl: string) => {
    action: "allow" | "deny" | "asset" | "defer";
    matchedRuleId?: string | null;
    matchedScope?: "site" | "global" | null;
  };
  onResult?: (page: CrawledPageResult) => void | Promise<void>;
  signal?: AbortSignal;
};

type CrawlSiteRun = {
  /** Requests the run handled. */
  pages: number;
  /**
   * True only when the run stopped because nothing was left to fetch: it read the site's sitemaps,
   * fetched every URL it queued and dropped none at the discovery limit. A run stopped by its
   * request budget or an abort, or with a request that never completed or ran out of time, is not
   * exhausted.
   */
  frontierExhausted: boolean;
};

/**
 * Above the longest a page legitimately takes: the HTTP fetch and its fallback (up to 60 s and
 * 30 s), a robots.txt read per redirect hop (15 s each), and publishing the page.
 */
const DEFAULT_PAGE_TIMEOUT_SECS = 300;

const discoveryLimitFor = (pageLimit: number): number => Math.max(pageLimit * 10, pageLimit + 50);

const crawlSiteInternal = async (params: CrawlSiteParams): Promise<CrawlSiteRun> => {
  ensureSystemBinaryPaths();
  const {
    baseUrl,
    pageLimit,
    totalPageLimit,
    pageConcurrency = 1,
    userAgent,
    includeUrlPatterns,
    excludeUrlPatterns,
    preserveContentLinks,
    seedDiscoveredUrls,
    seedPendingUrls,
    includeBaseUrl,
    fetchPage = fetchPageWithCrawlee,
    validateNavigationUrl,
    fetchImpl,
    getPageMetadata,
    onDiscoveredUrl,
    onSitemapUnread,
    pageTimeoutSecs = DEFAULT_PAGE_TIMEOUT_SECS,
    onCandidateUrl,
    onPage,
    resolvePolicy,
    onResult,
    signal
  } = params;
  let processed = 0;
  const discoveryLimit = discoveryLimitFor(totalPageLimit ?? pageLimit);
  const discovered = new Set<string>();
  // Request keys handed to the crawler, and the ones whose request completed.
  const queued = new Set<string>();
  const handled = new Set<string>();
  let droppedAtDiscoveryLimit = false;
  let sitemapUnread = false;
  // A request crawlee gave up on outside the handler, such as one that ran out of time.
  let requestFailedOutsideHandler = false;
  const claimedResolvedUrls = new Set<string>();
  const discoveryOnlyUrls = new Set<string>();
  log.setLevel(LogLevel.ERROR);
  const MAX_ERROR_MESSAGE_LENGTH = 500;
  const truncateErrorMessage = (value: string) => {
    if (value.length <= MAX_ERROR_MESSAGE_LENGTH) {
      return value;
    }
    return `${value.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
  };
  const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) {
      const fromError = (error.message || error.name || "Unknown error").trim();
      return truncateErrorMessage(fromError || "Unknown error");
    }
    if (typeof error === "string") {
      return truncateErrorMessage(error);
    }
    if (
      typeof error === "number" ||
      typeof error === "boolean" ||
      typeof error === "bigint" ||
      typeof error === "symbol"
    ) {
      return String(error);
    }
    if (error === null || typeof error === "undefined") {
      return "Unknown error";
    }
    if (typeof error === "object") {
      const typed = error as Record<string, unknown>;
      if (typeof typed.message === "string" && typed.message.trim()) {
        return truncateErrorMessage(typed.message.trim());
      }
      const tokens: string[] = [];
      if (typeof typed.name === "string" && typed.name.trim()) {
        tokens.push(typed.name.trim());
      }
      if (typeof typed.code === "string" || typeof typed.code === "number") {
        tokens.push(`code=${String(typed.code)}`);
      }
      if (typeof typed.status === "number") {
        tokens.push(`status=${typed.status}`);
      }
      if (tokens.length > 0) {
        return truncateErrorMessage(tokens.join(" "));
      }
    }
    return "Unknown error";
  };

  const canonicalize = (url: string): string | null => {
    const classification = classifyCrawlCandidateUrl(url, baseUrl);
    if (classification.reason !== "accepted") {
      return null;
    }
    return canonicalizeUrlIdentity(classification.canonicalUrl, {
      scopeBaseUrl: baseUrl
    })?.canonicalUrl ?? null;
  };

  const matchesPattern = matchesUrlPattern;

  const resolveSeedUrl = (
    rawUrl: string
  ): { canonicalUrl: string; publishable: boolean } | null => {
    const policyResolution = resolvePolicy?.(rawUrl);
    if (
      policyResolution?.action === "asset" ||
      policyResolution?.action === "defer" ||
      policyResolution?.action === "deny"
    ) {
      return null;
    }
    const classification = classifyCrawlCandidateUrl(rawUrl, baseUrl);
    if (classification.reason !== "accepted") {
      return null;
    }
    const canonicalUrl = canonicalize(classification.canonicalUrl);
    if (!canonicalUrl || matchesPattern(canonicalUrl, excludeUrlPatterns)) {
      return null;
    }
    return {
      canonicalUrl,
      publishable: (includeUrlPatterns?.length ?? 0) === 0 || matchesPattern(canonicalUrl, includeUrlPatterns)
    };
  };

  const enqueueCandidate = async (
    rawUrl: string,
    options?: { sourcePageUrl?: string | null; seed?: boolean }
  ): Promise<CrawlCandidateDecision> => {
    const policyResolution = resolvePolicy?.(rawUrl);
    if (policyResolution?.action === "asset") {
      return buildRejectedCandidateDecision(rawUrl, "policy_asset", null, policyResolution);
    }
    if (policyResolution?.action === "defer") {
      return buildRejectedCandidateDecision(rawUrl, "policy_defer", null, policyResolution);
    }
    if (policyResolution?.action === "deny") {
      return buildRejectedCandidateDecision(rawUrl, "policy_deny", null, policyResolution);
    }

    const classification = classifyCrawlCandidateUrl(rawUrl, baseUrl);
    if (classification.reason !== "accepted") {
      return buildRejectedCandidateDecision(rawUrl, classification.reason);
    }
    const canonicalUrl = canonicalize(classification.canonicalUrl);
    if (!canonicalUrl) {
      return buildRejectedCandidateDecision(rawUrl, "invalid_url");
    }
    if (matchesPattern(canonicalUrl, excludeUrlPatterns)) {
      return buildRejectedCandidateDecision(rawUrl, "policy_deny", canonicalUrl, {
        matchedRuleId: "excludeUrlPatterns",
        matchedScope: "site"
      });
    }
    if ((includeUrlPatterns?.length ?? 0) > 0 && !matchesPattern(canonicalUrl, includeUrlPatterns)) {
      return buildRejectedCandidateDecision(rawUrl, "policy_deny", canonicalUrl, {
        matchedRuleId: "includeUrlPatterns",
        matchedScope: "site"
      });
    }
    if (discovered.has(canonicalUrl) || claimedResolvedUrls.has(canonicalUrl)) {
      return buildRejectedCandidateDecision(rawUrl, "duplicate", canonicalUrl, policyResolution);
    }
    if (discovered.size >= discoveryLimit) {
      droppedAtDiscoveryLimit = true;
      return buildRejectedCandidateDecision(rawUrl, "page_limit_reached", canonicalUrl, policyResolution);
    }

    discovered.add(canonicalUrl);
    const decision = buildAcceptedCandidateDecision(rawUrl, canonicalUrl, policyResolution);
    if (!options?.seed && onDiscoveredUrl) {
      await onDiscoveredUrl(canonicalUrl);
    }
    if (!options?.seed && !queued.has(canonicalUrl)) {
      queued.add(canonicalUrl);
      await crawler.addRequests([{ url: canonicalUrl, uniqueKey: canonicalUrl }]);
    }
    return decision;
  };

  /**
   * The page URLs the site's sitemaps list. `unread` when robots.txt or a sitemap it lists could not
   * be read: a site without robots.txt has no sitemap, but one that failed to answer may have one.
   */
  const seedSitemapUrls = async (): Promise<{ urls: string[]; unread: boolean }> => {
    try {
      const robotsUrl = toOriginScopeUrl(baseUrl);
      const parsedRobotsUrl = new URL(robotsUrl);
      parsedRobotsUrl.pathname = "/robots.txt";
      const robots = await fetchText(parsedRobotsUrl.toString(), { signal, userAgent, validateNavigationUrl, fetchImpl });
      if (robots.status === 404) {
        return { urls: [], unread: false };
      }
      if (!robots.ok) {
        return { urls: [], unread: true };
      }
      const robotsFile = RobotsTxtFile.from(parsedRobotsUrl.toString(), robots.body);
      const sitemapPageUrls: string[] = [];
      let unread = false;
      for (const rawSitemapUrl of unique(robotsFile.getSitemaps())) {
        const sitemapUrl = normalizeSameOriginFetchUrl(rawSitemapUrl, robotsUrl);
        if (!sitemapUrl) {
          continue;
        }
        try {
          const sitemap = await fetchText(sitemapUrl, { signal, userAgent, validateNavigationUrl, fetchImpl });
          if (!sitemap.ok) {
            unread = true;
            continue;
          }
          sitemapPageUrls.push(...parseSitemapUrls(sitemap.body, sitemap.contentType));
        } catch {
          unread = true;
        }
      }
      return { urls: sitemapPageUrls, unread };
    } catch {
      return { urls: [], unread: true };
    }
  };

  const crawler = new BasicCrawler(
    {
      maxConcurrency: Math.max(1, pageConcurrency),
      maxRequestsPerCrawl: pageLimit,
      // The handler catches its own errors, so crawlee only fails a request that ran out of time. Its
      // handler is still running then: fetching the page again would race it.
      maxRequestRetries: 0,
      requestHandlerTimeoutSecs: pageTimeoutSecs,
      failedRequestHandler: () => {
        requestFailedOutsideHandler = true;
      },
      requestHandler: async ({ request }) => {
        const next = request.url;
        try {
          signal?.throwIfAborted();
          const metadata = getPageMetadata ? await getPageMetadata(next) : null;
          const page = await fetchPage(next, {
            ...(metadata ?? {}),
            scopeBaseUrl: baseUrl,
            userAgent,
            preserveContentLinks,
            validateNavigationUrl,
            fetchImpl,
            signal
          });
          signal?.throwIfAborted();
          const resolvedCanonical = canonicalize(page.url);
          if (!resolvedCanonical) {
            throw new Error(`Fetched URL out of crawl scope: ${page.url}`);
          }
          const alreadyClaimed = claimedResolvedUrls.has(resolvedCanonical);
          claimedResolvedUrls.add(resolvedCanonical);
          if (alreadyClaimed) {
            processed += 1;
            handled.add(request.uniqueKey);
            return;
          }
          const status = page.notModified ? "unchanged" : "success";
          const frontierCanonical = canonicalize(next);
          const discoveryOnlySkipReason = discoveryOnlyUrls.has(resolvedCanonical) ||
            (frontierCanonical ? discoveryOnlyUrls.has(frontierCanonical) : false)
            ? "Skipped by include URL policy"
            : null;
          const result: CrawledPageResult = {
            url: page.url,
            frontierUrl: next,
            title: page.title,
            text: page.text,
            html: page.html,
            httpStatus: page.httpStatus,
            links: page.links,
            parsedData: page.parsedData ?? null,
            etag: page.etag ?? null,
            lastModified: page.lastModified ?? null,
            status,
            transportUsed: page.transportUsed,
            httpAttempted: page.httpAttempted,
            browserAttempted: page.browserAttempted,
            browserFallbackReason: page.browserFallbackReason ?? null,
            httpQualityScore: page.httpQualityScore ?? null,
            pageType: page.pageType ?? "unknown",
            qualityScore: page.qualityScore ?? null,
            skipReason: discoveryOnlySkipReason ?? page.skipReason ?? null,
            extractedContainer: page.extractedContainer ?? null,
            normalizedContentHash: page.normalizedContentHash ?? null,
            images: page.images ?? []
          };
          // A page's links are queued and reported before the page is, so a run resumed from any
          // record that lists the page as processed also lists the pages it links to.
          for (const link of page.links) {
            const discovered = await enqueueCandidate(link, { sourcePageUrl: page.url });
            if (onCandidateUrl) {
              await onCandidateUrl({
                ...discovered,
                sourcePageUrl: page.url
              });
            }
          }
          processed += 1;
          if (onResult) {
            await onResult(result);
          }
          if (onPage) {
            await onPage({ url: page.url, status });
          }
          handled.add(request.uniqueKey);
        } catch (error) {
          if (signal?.aborted) {
            return;
          }
          const message = getErrorMessage(error);
          const metadata = readErrorMetadata(error);
          const result: CrawledPageResult = {
            url: next,
            frontierUrl: next,
            title: null,
            text: "",
            html: "",
            httpStatus: null,
            links: [],
            parsedData: null,
            status: "failed",
            error: message,
            ...metadata
          };
          processed += 1;
          if (onResult) {
            await onResult(result);
          }
          if (onPage) {
            await onPage({ url: next, status: "failed" });
          }
          handled.add(request.uniqueKey);
        }
      }
    },
    new Configuration({
      persistStorage: false,
      storageClient: new MemoryStorage({ persistStorage: false })
    })
  );

  signal?.addEventListener("abort", () => crawler.stop("Crawl aborted"), { once: true });

  for (const url of seedDiscoveredUrls ?? []) {
    const canonical = canonicalize(url);
    if (canonical) {
      discovered.add(canonical);
    }
  }
  const initialUrls: Array<{ url: string; uniqueKey: string }> = [];
  const seedPending = async (url: string) => {
    const seed = resolveSeedUrl(url);
    if (!seed || queued.has(seed.canonicalUrl)) {
      return;
    }
    discovered.add(seed.canonicalUrl);
    queued.add(seed.canonicalUrl);
    if (!seed.publishable) {
      discoveryOnlyUrls.add(seed.canonicalUrl);
    }
    initialUrls.push({ url: seed.canonicalUrl, uniqueKey: seed.canonicalUrl });
    // Reported like any queued link, so a run that stops before fetching it leaves it to the next.
    await onCandidateUrl?.({
      ...buildAcceptedCandidateDecision(url, seed.canonicalUrl),
      sourcePageUrl: baseUrl
    });
  };
  for (const url of seedPendingUrls ?? []) {
    await seedPending(url);
  }
  if (includeBaseUrl ?? true) {
    await seedPending(baseUrl);
  }
  const sitemaps = await seedSitemapUrls();
  if (sitemaps.unread && !signal?.aborted) {
    sitemapUnread = true;
    await onSitemapUnread?.();
  }
  for (const sitemapUrl of unique(sitemaps.urls)) {
    const decision = await enqueueCandidate(sitemapUrl, { sourcePageUrl: baseUrl, seed: true });
    if (onCandidateUrl) {
      await onCandidateUrl({
        ...decision,
        sourcePageUrl: baseUrl
      });
    }
    if (decision.decision !== "accepted" || !decision.canonicalUrl || queued.has(decision.canonicalUrl)) {
      continue;
    }
    queued.add(decision.canonicalUrl);
    initialUrls.push({ url: decision.canonicalUrl, uniqueKey: decision.canonicalUrl });
  }

  await crawler.run(initialUrls);

  return {
    pages: processed,
    frontierExhausted: !signal?.aborted &&
      !droppedAtDiscoveryLimit &&
      !sitemapUnread &&
      !requestFailedOutsideHandler &&
      [...queued].every((key) => handled.has(key)),
  };
};

export const crawlSiteStream = async (
  params: CrawlSiteParams & { onResult: (page: CrawledPageResult) => void | Promise<void> }
) => {
  return crawlSiteInternal(params);
};

export const crawlSite = async (params: Omit<CrawlSiteParams, "onResult">) => {
  const results: CrawledPageResult[] = [];
  await crawlSiteInternal({
    ...params,
    onResult: async (page) => {
      results.push(page);
    }
  });
  params.signal?.throwIfAborted();
  return results;
};

export type { CrawlSiteParams, CrawlSiteRun };
