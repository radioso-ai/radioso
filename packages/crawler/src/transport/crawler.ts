import {
  BasicCrawler,
  Configuration,
  LogLevel,
  MemoryStorage,
  RobotsTxtFile,
  log
} from "crawlee";
import type { CrawlCandidateDecision } from "./candidateDecision.js";
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
    signal?: AbortSignal;
  }
) => Promise<FetchedPage>;

type CrawlSiteParams = {
  baseUrl: string;
  pageLimit: number;
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
  getPageMetadata?: (
    url: string
  ) => Promise<{ etag?: string | null; lastModified?: string | null } | null>;
  onDiscoveredUrl?: (url: string) => void | Promise<void>;
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

const crawlSiteInternal = async (params: CrawlSiteParams) => {
  ensureSystemBinaryPaths();
  const {
    baseUrl,
    pageLimit,
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
    getPageMetadata,
    onDiscoveredUrl,
    onCandidateUrl,
    onPage,
    resolvePolicy,
    onResult,
    signal
  } = params;
  let processed = 0;
  const discoveryLimit = Math.max(pageLimit * 10, pageLimit + 50);
  const discovered = new Set<string>();
  const queued = new Set<string>();
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

  const seedSitemapUrls = async (): Promise<string[]> => {
    try {
      const robotsUrl = toOriginScopeUrl(baseUrl);
      const parsedRobotsUrl = new URL(robotsUrl);
      parsedRobotsUrl.pathname = "/robots.txt";
      const robots = await fetchText(parsedRobotsUrl.toString(), { signal, userAgent, validateNavigationUrl });
      if (robots.status === 404 || !robots.ok) {
        return [];
      }
      const robotsFile = RobotsTxtFile.from(parsedRobotsUrl.toString(), robots.body);
      const sitemapPageUrls: string[] = [];
      for (const rawSitemapUrl of unique(robotsFile.getSitemaps())) {
        const sitemapUrl = normalizeSameOriginFetchUrl(rawSitemapUrl, robotsUrl);
        if (!sitemapUrl) {
          continue;
        }
        try {
          const sitemap = await fetchText(sitemapUrl, { signal, userAgent, validateNavigationUrl });
          if (!sitemap.ok) {
            continue;
          }
          sitemapPageUrls.push(...parseSitemapUrls(sitemap.body, sitemap.contentType));
        } catch {
          continue;
        }
      }
      return sitemapPageUrls;
    } catch {
      return [];
    }
  };

  const crawler = new BasicCrawler(
    {
      maxConcurrency: Math.max(1, pageConcurrency),
      maxRequestsPerCrawl: pageLimit,
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
            normalizedContentHash: page.normalizedContentHash ?? null
          };
          processed += 1;
          if (onResult) {
            await onResult(result);
          }
          if (onPage) {
            await onPage({ url: page.url, status });
          }

          for (const link of page.links) {
            const discovered = await enqueueCandidate(link, { sourcePageUrl: page.url });
            if (onCandidateUrl) {
              await onCandidateUrl({
                ...discovered,
                sourcePageUrl: page.url
              });
            }
          }
        } catch (error) {
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
  };
  for (const url of seedPendingUrls ?? []) {
    await seedPending(url);
  }
  if (includeBaseUrl ?? true) {
    await seedPending(baseUrl);
  }
  for (const sitemapUrl of unique(await seedSitemapUrls())) {
    if (discovered.size >= discoveryLimit) {
      const canonicalUrl = canonicalize(sitemapUrl);
      if (onCandidateUrl) {
        await onCandidateUrl({
          ...buildRejectedCandidateDecision(sitemapUrl, "page_limit_reached", canonicalUrl),
          sourcePageUrl: baseUrl
        });
      }
      continue;
    }
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

  return { pages: processed };
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
  return results;
};

export type { CrawlSiteParams };
