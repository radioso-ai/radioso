import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { FetchedPage } from "./crawler.js";
import {
  extractStructuredTextWithFallback,
  hasPrimaryContentContainer,
  normalizeText,
  type ExtractionOptions,
} from "./htmlProcessing.js";

const ALWAYS_NON_CONTENT_SELECTOR = [
  "script",
  "style",
  "noscript",
  "svg",
  "nav",
  "form",
  "button",
  "[role='navigation']",
  "[aria-label*='menu' i]",
  "[aria-label*='navigation' i]",
].join(", ");

const CONTEXTUAL_NON_CONTENT_SELECTOR = [
  "header",
  "footer",
  "aside",
  "[role='banner']",
  "[role='contentinfo']",
].join(", ");

const NON_CONTENT_ATTRIBUTE_BASE_TOKENS = new Set([
  "cookie", "footer", "header", "login", "menu", "nav", "navbar", "navigation", "search",
]);
const NON_CONTENT_ATTRIBUTE_PREFIX_TOKENS = new Set([
  "bottom", "desktop", "global", "main", "mobile", "page", "primary", "secondary", "site", "sticky", "top",
]);
const NON_CONTENT_ATTRIBUTE_SUFFIX_TOKENS = new Set([
  "action", "actions", "bar", "block", "brand", "collapse", "container", "content", "drawer", "group",
  "inner", "item", "items", "legal", "link", "links", "list", "logo", "menu", "nav", "overlay", "panel",
  "section", "search", "style", "toggle", "wrapper",
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
  text: string,
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
  const baseIndex = segments.length > 1 && NON_CONTENT_ATTRIBUTE_PREFIX_TOKENS.has(segments[0]) ? 1 : 0;
  const base = segments[baseIndex];
  if (!NON_CONTENT_ATTRIBUTE_BASE_TOKENS.has(base)) {
    return false;
  }
  const suffixes = segments.slice(baseIndex + 1);
  if (suffixes.length === 0) {
    return baseIndex > 0;
  }
  return suffixes.every((suffix) => NON_CONTENT_ATTRIBUTE_SUFFIX_TOKENS.has(suffix));
};

const hasNonContentAttribute = (value: string | undefined): boolean =>
  Boolean(value?.split(/\s+/).some(isNonContentAttributeToken));

const elementName = (element: unknown): string => {
  const typed = element as { name?: unknown; tagName?: unknown };
  const name = typeof typed.name === "string"
    ? typed.name
    : typeof typed.tagName === "string" ? typed.tagName : "";
  return name.toLowerCase();
};

const removeAttributeMarkedPageChrome = ($: any): void => {
  $("[class], [id]").each((_index: number, element: unknown) => {
    if (PROTECTED_PAGE_CONTAINER_ELEMENTS.has(elementName(element))) {
      return;
    }
    const block = $(element);
    if (block.closest(PRIMARY_CONTENT_SELECTOR).length > 0 || block.find(PRIMARY_CONTENT_SUBTREE_SELECTOR).length > 0) {
      return;
    }
    if (hasNonContentAttribute(block.attr("class")) || hasNonContentAttribute(block.attr("id"))) {
      block.remove();
    }
  });
};

const removeContextualPageChrome = ($: any): void => {
  $(CONTEXTUAL_NON_CONTENT_SELECTOR).each((_index: number, element: unknown) => {
    const block = $(element);
    if (block.closest(PRIMARY_CONTENT_SELECTOR).length > 0 || block.find(PRIMARY_CONTENT_SUBTREE_SELECTOR).length > 0) {
      return;
    }
    block.remove();
  });
};

const removePageChrome = ($: any): void => {
  $(ALWAYS_NON_CONTENT_SELECTOR).remove();
  removeContextualPageChrome($);
  removeAttributeMarkedPageChrome($);
  $(LINK_DENSE_BLOCK_SELECTOR).each((_index: number, element: unknown) => {
    const block = $(element);
    if (block.closest(PRIMARY_CONTENT_SELECTOR).length > 0 || block.find(PRIMARY_CONTENT_SELECTOR).length > 0) {
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
    const linkDensity = normalizeText(anchors.text()).length / Math.max(text.length, 1);
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
  return normalizeText(anchors.text()).length / Math.max(text.length, 1) >= LINK_DENSE_MIN_RATIO;
};

export const extractLinks = ($: any, loadedUrl: string): string[] =>
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

export const buildFetchedHtmlPage = (input: {
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
    options: input.options,
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
    normalizedContentHash: hashNormalizedContent(text),
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
    ...diagnostics,
  };
};
