import { isIP } from "node:net";
import { delimiter as pathDelimiter } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { gunzipSync } from "node:zlib";
import {
  CheerioCrawler,
  Configuration,
  MemoryStorage,
  RobotsTxtFile,
} from "crawlee";
import type { FetchPage, FetchedPage, ValidateNavigationUrl } from "./crawler.js";
import { buildFetchedHtmlPage } from "./htmlContentExtraction.js";
import { decodeEntities } from "./htmlProcessing.js";
import { canonicalizeUrlIdentity } from "./url.js";

export const BLOCKED_HTTP_STATUS_CODES = new Set([401, 403, 429]);
const MAX_FETCH_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

const findTlsCertificateHostnameError = (error: unknown): Record<string, unknown> | null => {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      return record;
    }
    current = record.cause;
  }
  return null;
};

const resolveCertificateHostnameFallbackUrl = (url: string, error: unknown): string | null => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname.startsWith("www.") || isIP(parsed.hostname) !== 0) {
    return null;
  }
  const tlsError = findTlsCertificateHostnameError(error);
  if (!tlsError?.cert || typeof tlsError.cert !== "object") {
    return null;
  }
  const fallbackHostname = `www.${parsed.hostname}`;
  if (checkServerIdentity(fallbackHostname, tlsError.cert as PeerCertificate)) {
    return null;
  }
  parsed.hostname = fallbackHostname;
  return parsed.toString();
};

const fetchWithCertificateHostnameFallback = async (
  url: string,
  init: RequestInit,
  validateFallbackUrl?: (url: string) => Promise<void> | void,
): Promise<{ response: Response; requestUrl: string }> => {
  try {
    return { response: await fetch(url, init), requestUrl: url };
  } catch (error) {
    const fallbackUrl = resolveCertificateHostnameFallbackUrl(url, error);
    if (!fallbackUrl) {
      throw error;
    }
    await validateFallbackUrl?.(fallbackUrl);
    return { response: await fetch(fallbackUrl, init), requestUrl: fallbackUrl };
  }
};

const readNumericProperty = (input: Record<string, unknown>, name: string): number | undefined => {
  const value = input[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const readHttpStatusFromError = (error: Record<string, unknown>): number | undefined => {
  const direct = readNumericProperty(error, "statusCode") ?? readNumericProperty(error, "status");
  if (direct) {
    return direct;
  }
  const response = error.response;
  if (response && typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;
    const responseStatus = readNumericProperty(responseRecord, "statusCode") ?? readNumericProperty(responseRecord, "status");
    if (responseStatus) {
      return responseStatus;
    }
  }
  const message = typeof error.message === "string" ? error.message : "";
  const statusFromMessage = /^(\d{3})\b/.exec(message)?.[1];
  return statusFromMessage ? Number(statusFromMessage) : undefined;
};

export const readErrorMetadata = (
  error: unknown,
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
          httpQualityScore: null,
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
    httpQualityScore: typed.httpQualityScore,
  };
};

const parseContentLength = (headers: Headers): number | null => {
  const value = headers.get("content-length");
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const assertContentLengthWithinLimit = (headers: Headers): void => {
  const contentLength = parseContentLength(headers);
  if (contentLength !== null && contentLength > MAX_FETCH_RESPONSE_BYTES) {
    throw new Error(`Fetch response content-length ${contentLength} exceeds the ${MAX_FETCH_RESPONSE_BYTES} byte response limit.`);
  }
};

const readResponseBytes = async (response: Response): Promise<Buffer> => {
  assertContentLengthWithinLimit(response.headers);
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_FETCH_RESPONSE_BYTES) {
        throw new Error(`Fetch response body exceeds the ${MAX_FETCH_RESPONSE_BYTES} byte response limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
};

const decodeResponseBytes = (bytes: Buffer): Buffer => {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return bytes;
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Gzip response exceeds the ${MAX_DECOMPRESSED_BYTES} byte decompressed response limit.`);
    }
    throw error;
  }
};

export const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const toOriginScopeUrl = (rawUrl: string): string => {
  const parsed = new URL(rawUrl);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

export const normalizeSameOriginFetchUrl = (rawUrl: string, baseUrl: string): string | null => {
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

export const parseSitemapUrls = (content: string, contentType: string | null): string[] => {
  const trimmed = content.trim();
  if (contentType?.includes("text/plain") || (!trimmed.startsWith("<") && trimmed.length > 0)) {
    return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return [...trimmed.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeEntities(match[1].replace(/<[^>]+>/g, "").trim()))
    .filter(Boolean);
};

export const fetchText = async (
  url: string,
  options?: { signal?: AbortSignal; userAgent?: string; validateNavigationUrl?: ValidateNavigationUrl },
): Promise<{ ok: boolean; status: number; contentType: string | null; body: string }> => {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const fetchSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let currentUrl = new URL(url).toString();
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
    await options?.validateNavigationUrl?.(currentUrl);
    const fetched = await fetchWithCertificateHostnameFallback(currentUrl, {
      redirect: "manual",
      signal: fetchSignal,
      ...(options?.userAgent ? { headers: { "User-Agent": options.userAgent } } : {}),
    }, options?.validateNavigationUrl);
    currentUrl = fetched.requestUrl;
    response = fetched.response;
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
  const bytes = await readResponseBytes(response);
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: decodeResponseBytes(bytes).toString("utf8"),
  };
};

const createStorageConfig = () => new Configuration({
  persistStorage: false,
  storageClient: new MemoryStorage({ persistStorage: false }),
});

const REQUIRED_SYSTEM_BINARY_PATHS = process.platform === "win32" ? [] : ["/bin", "/usr/bin"];

export const ensureSystemBinaryPaths = (): void => {
  const currentPath = process.env.PATH ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  const missingEntries = REQUIRED_SYSTEM_BINARY_PATHS.filter((entry) => !pathEntries.includes(entry));
  if (missingEntries.length > 0) {
    process.env.PATH = [...pathEntries, ...missingEntries].join(pathDelimiter);
  }
};

const buildBlockedResponseError = (statusCode: number, retryAfter: string | null): Error => {
  const retryAfterSuffix = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
  const error = new Error(`Blocked by status code ${statusCode}${retryAfterSuffix}`);
  Object.defineProperty(error, "crawlMetadata", {
    value: { httpStatus: statusCode, transportUsed: "http", httpAttempted: true, browserAttempted: false, browserFallbackReason: null, httpQualityScore: null },
    enumerable: false,
  });
  return error;
};

const buildHttpResponseError = (statusCode: number, statusText: string, body: string): Error => {
  const message = `${statusCode}${statusText ? ` - ${statusText}` : ""}${body ? `: ${body.slice(0, 200)}` : ""}`;
  const error = new Error(message);
  Object.defineProperty(error, "crawlMetadata", {
    value: { httpStatus: statusCode, transportUsed: "http", httpAttempted: true, browserAttempted: false, browserFallbackReason: null, httpQualityScore: null },
    enumerable: false,
  });
  return error;
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
  options: Parameters<FetchPage>[1],
): Promise<void> => {
  const robotsScopeUrl = toOriginScopeUrl(options?.scopeBaseUrl ?? url);
  const parsedRobotsUrl = new URL(robotsScopeUrl);
  parsedRobotsUrl.pathname = "/robots.txt";
  const robots = await fetchText(parsedRobotsUrl.toString(), {
    signal: options?.signal,
    userAgent: options?.userAgent,
    validateNavigationUrl: options?.validateNavigationUrl,
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
  assertInScope: (candidateUrl: string) => void,
): Promise<FetchedPage> => {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const fetchSignal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let currentUrl = new URL(url).toString();
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 10; redirectCount += 1) {
    assertInScope(currentUrl);
    await options?.validateNavigationUrl?.(currentUrl);
    await assertPlainFetchAllowedByRobots(currentUrl, options);
    const fetched = await fetchWithCertificateHostnameFallback(currentUrl, {
      redirect: "manual",
      signal: fetchSignal,
      headers: {
        ...(options?.userAgent ? { "User-Agent": options.userAgent } : {}),
        ...(options?.etag ? { "If-None-Match": options.etag } : {}),
        ...(options?.lastModified ? { "If-Modified-Since": options.lastModified } : {}),
      },
    }, async (fallbackUrl) => {
      assertInScope(fallbackUrl);
      await options?.validateNavigationUrl?.(fallbackUrl);
    });
    currentUrl = fetched.requestUrl;
    response = fetched.response;
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
  const body = response.status === 304 ? "" : (await readResponseBytes(response)).toString("utf8");
  if (!response.ok && response.status !== 304) {
    throw buildHttpResponseError(response.status, response.statusText, body);
  }
  return buildFetchedHtmlPage({
    loadedUrl: currentUrl,
    originalHtml: body,
    statusCode: response.status,
    headers: response.headers,
    options: { preserveContentLinks: options?.preserveContentLinks },
  });
};

export const fetchPageWithCrawlee: FetchPage = async (url, options) => {
  ensureSystemBinaryPaths();
  let result: FetchedPage | null = null;
  let failure: unknown = null;
  const assertInScope = (candidateUrl: string) => {
    if (options?.scopeBaseUrl && !canonicalizeUrlIdentity(candidateUrl, { scopeBaseUrl: options.scopeBaseUrl })) {
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
            ...(options?.lastModified ? { "If-Modified-Since": options.lastModified } : {}),
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
        },
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
          options: { preserveContentLinks: options?.preserveContentLinks },
        });
      },
      failedRequestHandler: (_context, error) => {
        failure = error;
      },
    },
    createStorageConfig(),
  );
  options?.signal?.addEventListener("abort", () => crawler.stop("Crawl aborted"), { once: true });
  await crawler.run([{ url, uniqueKey: url }]);
  if (result) {
    return result;
  }
  if (shouldRetryWithPlainFetch(failure)) {
    return fetchPageWithPlainFetch(url, options, assertInScope);
  }
  throw failure instanceof Error ? failure : new Error("Crawlee fetch produced no page result");
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
