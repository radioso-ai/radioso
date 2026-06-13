import { createHash } from "node:crypto";
import { delimiter as pathDelimiter } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  BasicCrawler,
  CheerioCrawler,
  Configuration,
  LogLevel,
  MemoryStorage,
  RobotsTxtFile,
  log
} from "crawlee";
import { load } from "cheerio";
import type { CrawlCandidateDecision } from "./candidateDecision.js";
import { matchesUrlPattern } from "./urlPatterns.js";
import {
  buildAcceptedCandidateDecision,
  buildRejectedCandidateDecision
} from "./candidateDecision.js";
import {
  decodeEntities,
  extractStructuredTextWithFallback,
  hasPrimaryContentContainer,
  normalizeText,
  type ExtractionOptions
} from "./htmlProcessing.js";
import { canonicalizeUrlIdentity, classifyCrawlCandidateUrl } from "./url.js";

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

const BLOCKED_HTTP_STATUS_CODES = new Set([401, 403, 429]);

const readNumericProperty = (input: Record<string, unknown>, name: string): number | undefined => {
  const value = input[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const readHttpStatusFromError = (error: Record<string, unknown>): number | undefined => {
  const direct =
    readNumericProperty(error, "statusCode") ??
    readNumericProperty(error, "status");
  if (direct) {
    return direct;
  }

  const response = error.response;
  if (response && typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;
    const responseStatus =
      readNumericProperty(responseRecord, "statusCode") ??
      readNumericProperty(responseRecord, "status");
    if (responseStatus) {
      return responseStatus;
    }
  }

  const message = typeof error.message === "string" ? error.message : "";
  const statusFromMessage = /^(\d{3})\b/.exec(message)?.[1];
  return statusFromMessage ? Number(statusFromMessage) : undefined;
};

const readErrorMetadata = (
  error: unknown
): Partial<Pick<
  FetchedPage,
  "httpStatus" | "transportUsed" | "httpAttempted" | "browserAttempted" | "browserFallbackReason" | "httpQualityScore"
>> => {
  if (!error || typeof error !== "object") {
    return {};
  }
  const errorRecord = error as Record<string, unknown>;
  const metadata = (error as { crawlMetadata?: unknown }).crawlMetadata;
  if (!metadata || typeof metadata !== "object") {
    const httpStatus = readHttpStatusFromError(errorRecord);
    return httpStatus
      ? {
          httpStatus,
          transportUsed: "http",
          httpAttempted: true,
          browserAttempted: false,
          browserFallbackReason: null,
          httpQualityScore: null
        }
      : {};
  }
  const typed = metadata as Partial<FetchedPage>;
  return {
    httpStatus: typed.httpStatus ?? readHttpStatusFromError(errorRecord),
    transportUsed: typed.transportUsed,
    httpAttempted: typed.httpAttempted,
    browserAttempted: typed.browserAttempted,
    browserFallbackReason: typed.browserFallbackReason,
    httpQualityScore: typed.httpQualityScore
  };
};

const readHeader = (headers: unknown, name: string): string | null => {
  if (!headers || typeof headers !== "object") {
    return null;
  }
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : null;
  }
  const value = (headers as Record<string, unknown>)[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string") ?? null;
  }
  return typeof value === "string" ? value : null;
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const toOriginScopeUrl = (rawUrl: string): string => {
  const parsed = new URL(rawUrl);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const normalizeSameOriginFetchUrl = (rawUrl: string, baseUrl: string): string | null => {
  const candidateIdentity = canonicalizeUrlIdentity(rawUrl);
  const baseIdentity = canonicalizeUrlIdentity(baseUrl);
  if (!candidateIdentity || !baseIdentity) {
    return null;
  }
  const candidate = new URL(candidateIdentity.canonicalUrl);
  const base = new URL(baseIdentity.canonicalUrl);
  if (candidate.protocol !== base.protocol || candidate.host !== base.host) {
    return null;
  }
  candidate.username = "";
  candidate.password = "";
  return candidate.toString();
};

const parseSitemapUrls = (content: string, contentType: string | null): string[] => {
  const trimmed = content.trim();
  if (
    contentType?.includes("text/plain") ||
    (!trimmed.startsWith("<") && trimmed.length > 0)
  ) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [...trimmed.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, "").trim()))
    .filter(Boolean);
};

const fetchText = async (
  url: string,
  options?: {
    signal?: AbortSignal;
    userAgent?: string;
    validateNavigationUrl?: ValidateNavigationUrl;
  }
): Promise<{
  ok: boolean;
  status: number;
  contentType: string | null;
  body: string;
}> => {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const fetchSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let currentUrl = new URL(url).toString();
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
    await options?.validateNavigationUrl?.(currentUrl);
    response = await fetch(currentUrl, {
      redirect: "manual",
      signal: fetchSignal,
      ...(options?.userAgent ? { headers: { "User-Agent": options.userAgent } } : {})
    });
    if (response.status < 300 || response.status >= 400) {
      break;
    }
    const location = response.headers.get("location");
    if (!location) {
      break;
    }
    currentUrl = new URL(location, currentUrl).toString();
    await options?.validateNavigationUrl?.(currentUrl);
  }
  if (!response) {
    throw new Error("Text fetch produced no response");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: (isGzip ? gunzipSync(bytes) : bytes).toString("utf8")
  };
};

const DEFAULT_NON_CONTENT_SELECTOR = [
  "script",
  "style",
  "noscript",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[aria-label*='menu' i]",
  "[aria-label*='navigation' i]"
].join(", ");

const NON_CONTENT_ATTRIBUTE_BASE_TOKENS = new Set([
  "cookie",
  "footer",
  "header",
  "login",
  "menu",
  "nav",
  "navbar",
  "navigation",
  "search"
]);
const NON_CONTENT_ATTRIBUTE_PREFIX_TOKENS = new Set([
  "bottom",
  "desktop",
  "global",
  "main",
  "mobile",
  "page",
  "primary",
  "secondary",
  "site",
  "sticky",
  "top"
]);
const NON_CONTENT_ATTRIBUTE_SUFFIX_TOKENS = new Set([
  "action",
  "actions",
  "bar",
  "block",
  "brand",
  "collapse",
  "container",
  "content",
  "drawer",
  "group",
  "inner",
  "item",
  "items",
  "legal",
  "link",
  "links",
  "list",
  "logo",
  "menu",
  "nav",
  "overlay",
  "panel",
  "section",
  "search",
  "style",
  "toggle",
  "wrapper"
]);
const PROTECTED_PAGE_CONTAINER_ELEMENTS = new Set(["html", "head", "body"]);
const LINK_DENSE_BLOCK_SELECTOR = "ul, ol, section, div";
const LINK_DENSE_MIN_LINKS = 6;
const LINK_DENSE_MIN_RATIO = 0.75;
const PRIMARY_CONTENT_SELECTOR = "main, article, [role='main']";
const PRIMARY_CONTENT_SUBTREE_SELECTOR = "main, [role='main']";
const MIN_CONTENT_QUALITY_SCORE = 65;

type ExtractionDiagnostics = {
  pageType: NonNullable<FetchedPage["pageType"]>;
  qualityScore: number;
  skipReason: string | null;
  extractedContainer: string;
  normalizedContentHash: string;
};

const normalizeHashableContent = (value: string): string =>
  normalizeText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const hashNormalizedContent = (value: string): string =>
  createHash("sha256").update(normalizeHashableContent(value)).digest("hex");

const classifyPageType = (url: string, html: string): NonNullable<FetchedPage["pageType"]> => {
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (/\.(?:jpe?g|png|gif|webp|svg|pdf|zip|mp3|mp4|mov|avi|webm)$/i.test(path)) {
    return "asset";
  }
  if (/<article\b/i.test(html) || /\bitemtype\s*=\s*["'][^"']*Article/i.test(html)) {
    return "content";
  }
  return "unknown";
};

const scoreExtractedContent = (text: string): number => {
  if (!text.trim()) {
    return 0;
  }
  const length = text.length;
  const linkMatches = text.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/\S+/g) ?? [];
  const templateMatches = text.match(/\{\{[\s\S]*?\}\}/g) ?? [];
  const words = text.match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
  const uniqueWords = new Set(words.map((word) => word.toLowerCase()));
  let score = 100;
  if (length < 300) score -= 45;
  else if (length < 800) score -= 20;
  const linkDensity = linkMatches.join(" ").length / Math.max(length, 1);
  if (linkDensity > 0.35) score -= 35;
  else if (linkDensity > 0.2) score -= 20;
  const templateDensity = templateMatches.join(" ").length / Math.max(length, 1);
  if (templateDensity > 0.05) score -= 35;
  else if (templateDensity > 0.01) score -= 15;
  if (words.length > 20 && uniqueWords.size / words.length < 0.25) score -= 15;
  return Math.max(0, Math.min(100, Math.round(score)));
};

const resolveSkipReason = (
  pageType: NonNullable<FetchedPage["pageType"]>,
  qualityScore: number,
  text: string
): string | null => {
  if (!text.trim()) {
    return "Page did not contain crawlable content";
  }
  if (pageType === "asset" || pageType === "feed" || pageType === "search" || pageType === "listing") {
    return `Skipped ${pageType} page`;
  }
  if (qualityScore < MIN_CONTENT_QUALITY_SCORE) {
    return "Skipped low-quality extracted content";
  }
  return null;
};

const isNonContentAttributeToken = (token: string): boolean => {
  const normalized = token.trim().replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  if (NON_CONTENT_ATTRIBUTE_BASE_TOKENS.has(normalized)) {
    return true;
  }
  const segments = normalized.split(/[-_]+/).filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  const baseIndex =
    segments.length > 1 && NON_CONTENT_ATTRIBUTE_PREFIX_TOKENS.has(segments[0])
      ? 1
      : 0;
  const base = segments[baseIndex];
  if (!NON_CONTENT_ATTRIBUTE_BASE_TOKENS.has(base)) {
    return false;
  }
  const suffixes = segments.slice(baseIndex + 1);
  if (suffixes.length === 0) {
    return baseIndex > 0;
  }
  return (
    suffixes.every((suffix) => NON_CONTENT_ATTRIBUTE_SUFFIX_TOKENS.has(suffix))
  );
};

const hasNonContentAttribute = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }
  return value.split(/\s+/).some(isNonContentAttributeToken);
};

const elementName = (element: unknown): string => {
  const typed = element as { name?: unknown; tagName?: unknown };
  const name = typeof typed.name === "string"
    ? typed.name
    : typeof typed.tagName === "string"
      ? typed.tagName
      : "";
  return name.toLowerCase();
};

const removeAttributeMarkedPageChrome = ($: any): void => {
  $("[class], [id]").each((_index: number, element: unknown) => {
    if (PROTECTED_PAGE_CONTAINER_ELEMENTS.has(elementName(element))) {
      return;
    }
    const block = $(element);
    if (
      block.closest(PRIMARY_CONTENT_SELECTOR).length > 0 ||
      block.find(PRIMARY_CONTENT_SUBTREE_SELECTOR).length > 0
    ) {
      return;
    }
    if (
      hasNonContentAttribute(block.attr("class")) ||
      hasNonContentAttribute(block.attr("id"))
    ) {
      block.remove();
    }
  });
};

const removePageChrome = ($: any): void => {
  $(DEFAULT_NON_CONTENT_SELECTOR).remove();
  removeAttributeMarkedPageChrome($);
  $(LINK_DENSE_BLOCK_SELECTOR).each((_index: number, element: unknown) => {
    const block = $(element);
    if (
      block.closest(PRIMARY_CONTENT_SELECTOR).length > 0 ||
      block.find(PRIMARY_CONTENT_SELECTOR).length > 0
    ) {
      return;
    }
    const text = normalizeText(block.text());
    if (text.length < 80) {
      return;
    }
    const anchors = block.find("a");
    if (anchors.length < LINK_DENSE_MIN_LINKS) {
      return;
    }
    const linkText = normalizeText(anchors.text());
    const linkDensity = linkText.length / Math.max(text.length, 1);
    if (linkDensity >= LINK_DENSE_MIN_RATIO) {
      block.remove();
    }
  });
};

const isStructurallyLinkDensePage = ($: any): boolean => {
  const body = $("body");
  const scope = body.length > 0 ? body : $.root();
  const text = normalizeText(scope.text());
  if (text.length < 80) {
    return false;
  }
  const anchors = scope.find("a[href]");
  if (anchors.length < LINK_DENSE_MIN_LINKS) {
    return false;
  }
  const linkText = normalizeText(anchors.text());
  return linkText.length / Math.max(text.length, 1) >= LINK_DENSE_MIN_RATIO;
};

const extractLinks = ($: any, loadedUrl: string): string[] =>
  $("a[href]")
    .toArray()
    .map((anchor: unknown) => {
      const href = $(anchor).attr("href");
      if (!href) return null;
      try {
        return new URL(href, loadedUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((candidate: string | null): candidate is string => Boolean(candidate));

const createStorageConfig = () =>
  new Configuration({
    persistStorage: false,
    storageClient: new MemoryStorage({ persistStorage: false })
  });

const REQUIRED_SYSTEM_BINARY_PATHS = process.platform === "win32" ? [] : ["/bin", "/usr/bin"];

const ensureSystemBinaryPaths = () => {
  const currentPath = process.env.PATH ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  const missingEntries = REQUIRED_SYSTEM_BINARY_PATHS.filter((entry) => !pathEntries.includes(entry));
  if (missingEntries.length === 0) {
    return;
  }
  process.env.PATH = [...pathEntries, ...missingEntries].join(pathDelimiter);
};

const buildBlockedResponseError = (statusCode: number, retryAfter: string | null): Error => {
  const retryAfterSuffix = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
  const error = new Error(`Blocked by status code ${statusCode}${retryAfterSuffix}`);
  Object.defineProperty(error, "crawlMetadata", {
    value: {
      httpStatus: statusCode,
      transportUsed: "http",
      httpAttempted: true,
      browserAttempted: false,
      browserFallbackReason: null,
      httpQualityScore: null
    },
    enumerable: false
  });
  return error;
};

const buildHttpResponseError = (
  statusCode: number,
  statusText: string,
  body: string
): Error => {
  const message = `${statusCode}${statusText ? ` - ${statusText}` : ""}${body ? `: ${body.slice(0, 200)}` : ""}`;
  const error = new Error(message);
  Object.defineProperty(error, "crawlMetadata", {
    value: {
      httpStatus: statusCode,
      transportUsed: "http",
      httpAttempted: true,
      browserAttempted: false,
      browserFallbackReason: null,
      httpQualityScore: null
    },
    enumerable: false
  });
  return error;
};

const buildFetchedHtmlPage = (input: {
  loadedUrl: string;
  originalHtml: string;
  statusCode: number | null;
  headers: unknown;
  options?: ExtractionOptions;
}): FetchedPage => {
  const $ = load(input.originalHtml);
  const originalLinks = extractLinks($, input.loadedUrl);
  const structurallyLinkDense = isStructurallyLinkDensePage($);
  removePageChrome($);
  const html = $.html();
  const cleanedLinks = extractLinks($, input.loadedUrl);
  const text = extractStructuredTextWithFallback({
    cleanedHtml: html,
    originalHtml: input.originalHtml,
    baseUrl: input.loadedUrl,
    options: input.options
  });
  const pageType = classifyPageType(input.loadedUrl, input.originalHtml);
  const resolvedPageType = pageType === "unknown" && !hasPrimaryContentContainer(input.originalHtml) && structurallyLinkDense
    ? "listing"
    : pageType;
  const qualityScore = scoreExtractedContent(text);
  const diagnostics: ExtractionDiagnostics = {
    pageType: resolvedPageType,
    qualityScore,
    skipReason: resolveSkipReason(resolvedPageType, qualityScore, text),
    extractedContainer: hasPrimaryContentContainer(input.originalHtml) ? "primary" : "body",
    normalizedContentHash: hashNormalizedContent(text)
  };
  return {
    url: input.loadedUrl,
    title: $("title").text() || null,
    text,
    html,
    httpStatus: input.statusCode,
    links: cleanedLinks.length > 0 ? cleanedLinks : originalLinks,
    parsedData: null,
    etag: readHeader(input.headers, "etag"),
    lastModified: readHeader(input.headers, "last-modified"),
    notModified: input.statusCode === 304,
    transportUsed: "http",
    httpAttempted: true,
    browserAttempted: false,
    browserFallbackReason: null,
    httpQualityScore: null,
    ...diagnostics
  };
};

const shouldRetryWithPlainFetch = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return true;
  }
  const metadata = readErrorMetadata(error);
  if (metadata.httpStatus) {
    return false;
  }
  const message = error instanceof Error ? error.message : "";
  return !message.includes("Fetched URL out of crawl scope");
};

const assertPlainFetchAllowedByRobots = async (
  url: string,
  options: Parameters<FetchPage>[1]
): Promise<void> => {
  const robotsScopeUrl = toOriginScopeUrl(options?.scopeBaseUrl ?? url);
  const parsedRobotsUrl = new URL(robotsScopeUrl);
  parsedRobotsUrl.pathname = "/robots.txt";
  const robots = await fetchText(parsedRobotsUrl.toString(), {
    signal: options?.signal,
    userAgent: options?.userAgent,
    validateNavigationUrl: options?.validateNavigationUrl
  });
  if (robots.status === 404 || !robots.ok) {
    return;
  }
  const robotsFile = RobotsTxtFile.from(parsedRobotsUrl.toString(), robots.body);
  if (!robotsFile.isAllowed(url, options?.userAgent ?? "*")) {
    throw new Error("Blocked by robots.txt");
  }
};

const fetchPageWithPlainFetch = async (
  url: string,
  options: Parameters<FetchPage>[1],
  assertInScope: (candidateUrl: string) => void
): Promise<FetchedPage> => {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const fetchSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let currentUrl = new URL(url).toString();
  let response: Response | null = null;

  for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
    assertInScope(currentUrl);
    await options?.validateNavigationUrl?.(currentUrl);
    await assertPlainFetchAllowedByRobots(currentUrl, options);
    response = await fetch(currentUrl, {
      redirect: "manual",
      signal: fetchSignal,
      headers: {
        ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
        ...(options?.etag ? { "If-None-Match": options.etag } : {}),
        ...(options?.lastModified ? { "If-Modified-Since": options.lastModified } : {})
      }
    });

    if (response.status < 300 || response.status >= 400) {
      break;
    }

    const location = response.headers.get("location");
    if (!location) {
      break;
    }
    currentUrl = new URL(location, currentUrl).toString();
    await options?.validateNavigationUrl?.(currentUrl);
  }

  if (!response) {
    throw new Error("Plain fetch produced no page response");
  }

  assertInScope(currentUrl);
  await options?.validateNavigationUrl?.(currentUrl);
  if (BLOCKED_HTTP_STATUS_CODES.has(response.status)) {
    throw buildBlockedResponseError(response.status, response.headers.get("retry-after"));
  }

  const body = response.status === 304 ? "" : await response.text();
  if (!response.ok && response.status !== 304) {
    throw buildHttpResponseError(response.status, response.statusText, body);
  }

  return buildFetchedHtmlPage({
    loadedUrl: currentUrl,
    originalHtml: body,
    statusCode: response.status,
    headers: response.headers,
    options: {
      preserveContentLinks: options?.preserveContentLinks
    }
  });
};

const fetchPageWithCrawlee: FetchPage = async (url, options) => {
  ensureSystemBinaryPaths();
  let result: FetchedPage | null = null;
  let failure: unknown = null;
  const assertInScope = (candidateUrl: string) => {
    if (
      options?.scopeBaseUrl &&
      !canonicalizeUrlIdentity(candidateUrl, { scopeBaseUrl: options.scopeBaseUrl })
    ) {
      throw new Error(`Fetched URL out of crawl scope: ${candidateUrl}`);
    }
  };
  const crawler = new CheerioCrawler(
    {
      maxRequestsPerCrawl: 1,
      maxConcurrency: 1,
      maxRequestRetries: 0,
      useSessionPool: false,
      respectRobotsTxtFile: false,
      preNavigationHooks: [
        async ({ request }, gotOptions) => {
          assertInScope(request.url);
          await options?.validateNavigationUrl?.(request.url);
          await assertPlainFetchAllowedByRobots(request.url, options);
          request.headers = {
            ...request.headers,
            ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
            ...(options?.etag ? { "If-None-Match": options.etag } : {}),
            ...(options?.lastModified ? { "If-Modified-Since": options.lastModified } : {})
          };
          gotOptions.hooks ??= {};
          gotOptions.hooks.beforeRedirect ??= [];
          gotOptions.hooks.beforeRedirect.push(async (redirectOptions) => {
            const redirectUrl = redirectOptions.url?.toString();
            if (redirectUrl) {
              assertInScope(redirectUrl);
              await options?.validateNavigationUrl?.(redirectUrl);
            }
          });
        }
      ],
      requestHandler: async ({ request, response, $ }) => {
        const loadedUrl = request.loadedUrl ?? request.url;
        assertInScope(loadedUrl);
        await options?.validateNavigationUrl?.(loadedUrl);
        const statusCode = response?.statusCode ?? null;
        if (statusCode && BLOCKED_HTTP_STATUS_CODES.has(statusCode)) {
          throw buildBlockedResponseError(statusCode, readHeader(response?.headers, "retry-after"));
        }
        result = buildFetchedHtmlPage({
          loadedUrl,
          originalHtml: $.html(),
          statusCode,
          headers: response?.headers,
          options: {
            preserveContentLinks: options?.preserveContentLinks
          }
        });
      },
      failedRequestHandler: (_context, error) => {
        failure = error;
      }
    },
    createStorageConfig()
  );
  options?.signal?.addEventListener("abort", () => crawler.stop("Crawl aborted"), {
    once: true
  });
  await crawler.run([{ url, uniqueKey: url }]);
  if (result) {
    return result;
  }
  if (shouldRetryWithPlainFetch(failure)) {
    return fetchPageWithPlainFetch(url, options, assertInScope);
  }
  throw failure instanceof Error ? failure : new Error("Crawlee fetch produced no page result");
};

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
