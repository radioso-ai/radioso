import type { FetchPage, FetchedPage } from "./crawler.js";
import { extractStructuredTextWithFallback } from "./htmlProcessing.js";

export type FetchedPageWithScreenshot = FetchedPage & {
  screenshot: Uint8Array | null;
  faviconUrl: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwrightModule: any = null;

const loadPlaywright = async () => {
  if (playwrightModule) {
    return playwrightModule;
  }
  try {
    playwrightModule = await import("playwright");
    return playwrightModule;
  } catch {
    throw new Error(
      "Playwright is required for browser transport but is not installed. " +
        "Install it with: npm install playwright"
    );
  }
};

const NAVIGATION_TIMEOUT = 30_000;
const VIEWPORT = { width: 1280, height: 800 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractLinksFromPage = async (page: any, baseUrl: string): Promise<string[]> => {
  const hrefs: string[] = await page.$$eval(
    "a[href]",
    (anchors: Element[]) =>
      anchors
        .map((a) => a.getAttribute("href"))
        .filter((h: string | null): h is string => Boolean(h))
  );
  const links: string[] = [];
  for (const href of hrefs) {
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {
      // skip invalid URLs
    }
  }
  return links;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractFaviconUrl = async (page: any, baseUrl: string): Promise<string | null> => {
  const candidates: Array<{ href: string; priority: number }> = await page.$$eval(
    'link[rel*="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]',
    (links: Element[]) =>
      links
        .map((link) => {
          const href = link.getAttribute("href");
          const rel = (link.getAttribute("rel") ?? "").toLowerCase();
          if (!href) return null;
          let priority = 0;
          if (rel.includes("apple-touch-icon-precomposed")) priority = 3;
          else if (rel.includes("apple-touch-icon")) priority = 2;
          else if (rel.includes("icon")) priority = 1;
          const sizes = link.getAttribute("sizes") ?? "";
          const sizeMatch = /(\d+)x(\d+)/.exec(sizes);
          if (sizeMatch) {
            priority += Math.min(Number(sizeMatch[1]), 512) / 512;
          }
          return { href, priority };
        })
        .filter((c: { href: string; priority: number } | null): c is { href: string; priority: number } => c !== null)
  );

  candidates.sort((a, b) => b.priority - a.priority);
  const best = candidates[0];
  if (best) {
    try {
      return new URL(best.href, baseUrl).toString();
    } catch {
      // fall through
    }
  }

  try {
    const fallback = new URL("/favicon.ico", baseUrl).toString();
    const response = await page.context().request.head(fallback).catch(() => null);
    if (response && response.ok()) {
      return fallback;
    }
  } catch {
    // fall through
  }

  return null;
};

const fetchWithPlaywright = async (
  url: string,
  options?: {
    etag?: string | null;
    lastModified?: string | null;
    scopeBaseUrl?: string | null;
    userAgent?: string;
    signal?: AbortSignal;
    captureScreenshot?: boolean;
  }
): Promise<FetchedPageWithScreenshot> => {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({
    headless: true,
    args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    options?.signal?.throwIfAborted();

    const context = await browser.newContext({
      viewport: VIEWPORT,
      ...(options?.userAgent ? { userAgent: options.userAgent } : {})
    });

    try {
      const page = await context.newPage();
      const abortHandler = () => {
        page.close().catch(() => {});
      };
      options?.signal?.addEventListener("abort", abortHandler, { once: true });

      try {
        const response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: NAVIGATION_TIMEOUT
        });

        const loadedUrl = page.url();
        if (options?.scopeBaseUrl) {
          let loadedOrigin: string;
          let scopeOrigin: string;
          try {
            loadedOrigin = new URL(loadedUrl).origin;
            scopeOrigin = new URL(options.scopeBaseUrl).origin;
          } catch {
            throw new Error(`Fetched URL out of crawl scope: ${loadedUrl}`);
          }
          if (loadedOrigin !== scopeOrigin) {
            throw new Error(`Fetched URL out of crawl scope: ${loadedUrl}`);
          }
        }

        const httpStatus = response?.status() ?? null;
        const title = (await page.title()) || null;
        const html = await page.content();
        const links = await extractLinksFromPage(page, loadedUrl);

        const text = extractStructuredTextWithFallback({
          cleanedHtml: html,
          originalHtml: html
        });

        let screenshot: Uint8Array | null = null;
        if (options?.captureScreenshot !== false) {
          screenshot = (await page.screenshot({ type: "png" }).catch(() => null)) as Uint8Array | null;
        }

        const faviconUrl = await extractFaviconUrl(page, loadedUrl);

        return {
          url: loadedUrl,
          title,
          text,
          html,
          httpStatus,
          links,
          parsedData: null,
          transportUsed: "browser",
          httpAttempted: false,
          browserAttempted: true,
          browserFallbackReason: null,
          httpQualityScore: null,
          screenshot,
          faviconUrl
        };
      } finally {
        options?.signal?.removeEventListener("abort", abortHandler);
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
};

export const fetchPageWithPlaywright: FetchPage = async (url, options) => {
  const result = await fetchWithPlaywright(url, {
    ...options,
    captureScreenshot: false
  });
  const { screenshot: _screenshot, faviconUrl: _faviconUrl, ...page } = result;
  return page;
};

export const fetchPageWithScreenshot = async (
  url: string,
  options?: {
    etag?: string | null;
    lastModified?: string | null;
    scopeBaseUrl?: string | null;
    userAgent?: string;
    signal?: AbortSignal;
  }
): Promise<FetchedPageWithScreenshot> => {
  return fetchWithPlaywright(url, {
    ...options,
    captureScreenshot: true
  });
};
