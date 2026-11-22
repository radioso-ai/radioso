import { WebsiteCrawlerBadRequestError, redactSensitiveText } from "./errors.js";

/**
 * The page addresses a crawl works with: how a site's base URL and a page URL are normalized, how
 * a page URL is redacted before it is stored, and the external document id a crawled page is
 * published under. Ingestion and the removal of missing pages both build ids here, so they agree.
 */
export const buildWebsiteExternalDocumentId = (input: {
  websiteBaseUrl: string;
  pageUrl: string;
}): string => `${websiteExternalDocumentIdPrefix(input.websiteBaseUrl)}${redactWebsiteCrawlerUrl(normalizePageUrl(input.pageUrl))}`;

/** What every external document id a crawl of this site publishes starts with. */
export const websiteExternalDocumentIdPrefix = (websiteBaseUrl: string): string =>
  `website:${redactWebsiteCrawlerUrl(normalizeBaseUrl(websiteBaseUrl))}:`;

const SENSITIVE_QUERY_PARAM_PATTERNS = [
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /authorization/i,
  /password/i,
  /credential/i,
  /signature/i,
  /^sig$/i,
  /^key$/i,
];

export const redactWebsiteCrawlerUrl = (value: string): string => {
  const url = parseHttpUrl(value);
  rejectUrlCredentials(url);
  for (const [key, value] of Array.from(url.searchParams.entries())) {
    const redactedValue = isSensitiveQueryParam(key) ? "[redacted]" : redactSensitiveText(value);
    if (redactedValue !== value) {
      url.searchParams.set(key, redactedValue);
    }
  }
  return normalizePageUrl(url.toString());
};

/** Whether {@link redactWebsiteCrawlerUrl} replaced part of this address, so it is no longer the page's real one. */
export const wasRedacted = (url: string): boolean => url.includes("[redacted]") || url.toLowerCase().includes("%5bredacted%5d");

const isSensitiveQueryParam = (key: string): boolean =>
  SENSITIVE_QUERY_PARAM_PATTERNS.some((pattern) => pattern.test(key));

export const safeFailureSourceUrl = (value: string | null | undefined): string => {
  if (!value) {
    return "unknown";
  }
  try {
    return redactWebsiteCrawlerUrl(normalizePageUrl(value));
  } catch {
    return "invalid-url";
  }
};

export const normalizeBaseUrl = (value: string): string => {
  const url = parseHttpUrl(value);
  rejectUrlCredentials(url);
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/$/, "");
};

export const normalizePageUrl = (value: string): string => {
  const url = parseHttpUrl(value);
  rejectUrlCredentials(url);
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/$/, "");
};

const parseHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebsiteCrawlerBadRequestError("URL must be valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebsiteCrawlerBadRequestError("URL must use http or https");
  }
  return url;
};

const rejectUrlCredentials = (url: URL): void => {
  if (url.username || url.password) {
    throw new WebsiteCrawlerBadRequestError("URL must not include credentials");
  }
};
