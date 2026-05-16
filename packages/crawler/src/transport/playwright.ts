import type { FetchPage, FetchedPage } from "./crawler.js";
import { extractStructuredTextWithFallback } from "./htmlProcessing.js";

export type FetchedPageWithScreenshot = FetchedPage & {
  screenshot: Uint8Array | null;
  faviconUrl: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let playwrightModule: any = null;
let playwrightAvailability: boolean | null = null;

const loadPlaywright = async () => {
  if (playwrightModule) {
    return playwrightModule;
  }
  try {
    playwrightModule = await import("playwright");
    playwrightAvailability = true;
    return playwrightModule;
  } catch {
    playwrightAvailability = false;
    throw new Error(
      "Playwright is required for browser transport but is not installed. " +
        "Install it with: npm install playwright"
    );
  }
};

/**
 * Capability probe for callers that need to decide between browser and HTTP
 * transports up-front rather than catching a thrown error mid-flow. Returns
 * true when the optional `playwright` dependency is resolvable in the current
 * runtime, false otherwise. Caches the result so repeat calls are cheap.
 */
export const isPlaywrightAvailable = async (): Promise<boolean> => {
  if (playwrightAvailability !== null) {
    return playwrightAvailability;
  }
  try {
    playwrightModule = await import("playwright");
    playwrightAvailability = true;
  } catch {
    playwrightAvailability = false;
  }
  return playwrightAvailability;
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
    // Disable redirects on the probe. Playwright's API request context
    // doesn't go through context.route(), so a 301 here could send a request
    // to a private host before our SSRF validator ever sees it. If the
    // favicon needs a redirect to resolve, we'd rather return null and have
    // the agent be logoless than risk an unvalidated server-side request.
    const response = await page
      .context()
      .request.head(fallback, { maxRedirects: 0 })
      .catch(() => null);
    if (response && response.ok()) {
      return fallback;
    }
  } catch {
    // fall through
  }

  return null;
};

const BLOCKED_HTTP_STATUS_CODES = new Set([401, 403, 429]);

const fetchWithPlaywright = async (
  url: string,
  options?: {
    etag?: string | null;
    lastModified?: string | null;
    scopeBaseUrl?: string | null;
    userAgent?: string;
    signal?: AbortSignal;
    captureScreenshot?: boolean;
    /**
     * Called before every top-level navigation request (including redirects).
     * Throw to abort the request. This runs before the request is sent to the
     * network, so it's safe to use for SSRF policy enforcement.
     */
    validateNavigationUrl?: (url: string) => Promise<void> | void;
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

      let validationError: unknown = null;
      if (options?.validateNavigationUrl) {
        const validator = options.validateNavigationUrl;
        // Intercept every request and validate the URL before it's allowed
        // onto the wire. Aborting the route prevents the request from ever
        // contacting the target, so SSRF redirects can't reach private hosts
        // even briefly. This applies to BOTH document navigations and
        // subresources (images, scripts, stylesheets, fetch/XHR): a page
        // with <img src="http://169.254.169.254/..."> would otherwise force
        // the headless browser to fetch that internal URL.
        await context.route("**/*", async (route: any) => {
          const request = route.request();
          const isDocument = request.resourceType() === "document";
          try {
            await validator(request.url());
          } catch (error) {
            if (isDocument) {
              // A blocked document navigation kills the whole page load —
              // record the error so it surfaces as the goto() failure.
              validationError = error;
            }
            // Subresource failures just drop that one resource; the page
            // still renders without it, which is the safer default.
            await route.abort();
            return;
          }
          await route.continue();
        });
      }

      try {
        let response: any;
        try {
          response = await page.goto(url, {
            waitUntil: "networkidle",
            timeout: NAVIGATION_TIMEOUT
          });
        } catch (error) {
          if (validationError) {
            throw validationError;
          }
          throw error;
        }

        if (validationError) {
          throw validationError;
        }

        const status = response?.status() ?? null;
        if (typeof status === "number" && BLOCKED_HTTP_STATUS_CODES.has(status)) {
          throw new Error(`Blocked by status code ${status}`);
        }

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
    /**
     * Called before every top-level navigation request (including
     * redirects) — the SSRF gate. Throw to abort the request before it
     * hits the wire. This must be in the public signature so callers can
     * type-check that they're passing it; otherwise the validator would
     * only reach fetchWithPlaywright by lucky runtime spread.
     */
    validateNavigationUrl?: (url: string) => Promise<void> | void;
  }
): Promise<FetchedPageWithScreenshot> => {
  return fetchWithPlaywright(url, {
    ...options,
    captureScreenshot: true
  });
};
