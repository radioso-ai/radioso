import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlSiteStream, type FetchPage } from "../../src/index.js";

// Pages come from `fetchPage`; the server only answers robots.txt, so no sitemap seeds the crawl.
const listenWithoutRobots = async (): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

/** A server that answers only the paths it is given, with the status and body it is given. */
const listenAnswering = async (answers: Record<string, { status: number; body?: string }>): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer((req, res) => {
    const answer = answers[req.url ?? ""];
    if (!answer) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(answer.status, { "content-type": "text/plain" }).end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

type SitePage = { links?: string[]; redirectTo?: string };

/** A site as `fetchPage` sees it: each path's links, or the path a request for it lands on. */
const siteFetcher = (baseUrl: string, pages: Record<string, SitePage>): FetchPage => async (url) => {
  const path = new URL(url).pathname;
  const page = pages[path];
  if (!page) {
    throw new Error(`No page at ${path}`);
  }
  return {
    url: page.redirectTo ? `${baseUrl}${page.redirectTo}` : url,
    title: path,
    text: `The ${path} page.`,
    html: "",
    httpStatus: 200,
    links: (page.links ?? []).map((link) => `${baseUrl}${link}`),
  };
};

describe("a crawl run's frontier", () => {
  let servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers = [];
  });

  const site = async () => {
    const listening = await listenWithoutRobots();
    servers.push(listening.server);
    return listening.baseUrl;
  };

  it("is exhausted when the run fetched every page it found", async () => {
    const baseUrl = await site();
    const onResult = vi.fn();

    const run = await crawlSiteStream({
      baseUrl,
      pageLimit: 10,
      onResult,
      fetchPage: siteFetcher(baseUrl, {
        "/": { links: ["/a", "/b"] },
        "/a": { links: ["/", "/b"] },
        "/b": {},
      }),
    });

    expect(run).toEqual({ pages: 3, frontierExhausted: true });
  });

  it("is not exhausted when the request budget runs out, even on requests that publish no page", async () => {
    const baseUrl = await site();
    const onResult = vi.fn();

    // `/moved` lands on `/`, which the run already fetched: it spends a request and yields no page.
    const run = await crawlSiteStream({
      baseUrl,
      pageLimit: 3,
      onResult,
      fetchPage: siteFetcher(baseUrl, {
        "/": { links: ["/moved", "/b", "/c"] },
        "/moved": { redirectTo: "/" },
        "/b": {},
        "/c": {},
      }),
    });

    expect(onResult).toHaveBeenCalledTimes(2);
    expect(run.frontierExhausted).toBe(false);
  });

  const answeringSite = async (answers: (baseUrl: string) => Record<string, { status: number; body?: string }>) => {
    let baseUrl = "";
    const listening = await listenAnswering(new Proxy({}, { get: (_target, path: string) => answers(baseUrl)[path] }));
    servers.push(listening.server);
    baseUrl = listening.baseUrl;
    return baseUrl;
  };

  it("is not exhausted, and says so once, when robots.txt cannot be read", async () => {
    const baseUrl = await answeringSite(() => ({ "/robots.txt": { status: 503 } }));
    const onSitemapUnread = vi.fn();

    const run = await crawlSiteStream({
      baseUrl,
      pageLimit: 10,
      onResult: vi.fn(),
      onSitemapUnread,
      fetchPage: siteFetcher(baseUrl, { "/": {} }),
    });

    expect(run.frontierExhausted).toBe(false);
    expect(onSitemapUnread).toHaveBeenCalledOnce();
  });

  it("is not exhausted when a sitemap robots.txt lists cannot be read", async () => {
    const baseUrl = await answeringSite((base) => ({
      "/robots.txt": { status: 200, body: `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml` },
      "/sitemap.xml": { status: 500 },
    }));
    const onSitemapUnread = vi.fn();

    const run = await crawlSiteStream({
      baseUrl,
      pageLimit: 10,
      onResult: vi.fn(),
      onSitemapUnread,
      fetchPage: siteFetcher(baseUrl, { "/": {} }),
    });

    expect(run.frontierExhausted).toBe(false);
    expect(onSitemapUnread).toHaveBeenCalledOnce();
  });

  it("is exhausted when the site has no robots.txt, and when its sitemaps all read", async () => {
    const withSitemap = await answeringSite((base) => ({
      "/robots.txt": { status: 200, body: `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.txt` },
      "/sitemap.txt": { status: 200, body: `${base}/a\n` },
    }));
    const onSitemapUnread = vi.fn();

    const run = await crawlSiteStream({
      baseUrl: withSitemap,
      pageLimit: 10,
      onResult: vi.fn(),
      onSitemapUnread,
      fetchPage: siteFetcher(withSitemap, { "/": {}, "/a": {} }),
    });

    expect(run).toEqual({ pages: 2, frontierExhausted: true });
    expect(onSitemapUnread).not.toHaveBeenCalled();
  });

  it("records a page's links before it reports the page processed", async () => {
    const baseUrl = await site();
    const events: string[] = [];

    await crawlSiteStream({
      baseUrl,
      pageLimit: 10,
      onCandidateUrl: (decision) => {
        if (decision.decision === "accepted" && decision.canonicalUrl !== baseUrl) {
          events.push(`discovered ${new URL(decision.canonicalUrl ?? "").pathname}`);
        }
      },
      onResult: (page) => {
        events.push(`processed ${new URL(page.url).pathname}`);
      },
      fetchPage: siteFetcher(baseUrl, { "/": { links: ["/a"] }, "/a": {} }),
    });

    expect(events).toEqual(["discovered /a", "processed /", "processed /a"]);
  });

  it("reports the pages it is seeded with as discovered, so a later run can resume them", async () => {
    const baseUrl = await site();
    const accepted: string[] = [];

    await crawlSiteStream({
      baseUrl,
      pageLimit: 10,
      seedPendingUrls: [`${baseUrl}/pending`],
      onCandidateUrl: (decision) => {
        if (decision.decision === "accepted") accepted.push(decision.canonicalUrl ?? "");
      },
      onResult: vi.fn(),
      fetchPage: siteFetcher(baseUrl, { "/": {}, "/pending": {} }),
    });

    expect(accepted).toEqual(expect.arrayContaining([baseUrl, `${baseUrl}/pending`]));
  });

  it("does not fetch a page again when it outlives its time, and is not exhausted", async () => {
    const baseUrl = await site();
    let slowPageDone: Promise<void> = Promise.resolve();
    const fetchPage = vi.fn<FetchPage>(async (url) => {
      slowPageDone = new Promise((resolve) => setTimeout(resolve, 1_500));
      await slowPageDone;
      return { url, title: "/", text: "The / page.", html: "", httpStatus: 200, links: [] };
    });

    const run = await crawlSiteStream({
      baseUrl,
      pageLimit: 10,
      pageTimeoutSecs: 1,
      onResult: vi.fn(),
      fetchPage,
    });
    await slowPageDone;

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(run.frontierExhausted).toBe(false);
  });

  const continuedRun = async (baseUrl: string, totalPageLimit?: number) => {
    const decisions: string[] = [];
    const run = await crawlSiteStream({
      baseUrl,
      pageLimit: 2,
      ...(totalPageLimit ? { totalPageLimit } : {}),
      // An earlier run of the same crawl discovered 60 pages and left `/` to fetch.
      seedDiscoveredUrls: Array.from({ length: 60 }, (_, index) => `${baseUrl}/seen-${index}`),
      seedPendingUrls: [`${baseUrl}/`],
      includeBaseUrl: false,
      onResult: vi.fn(),
      onCandidateUrl: (decision) => {
        decisions.push(decision.reason);
      },
      fetchPage: siteFetcher(baseUrl, { "/": { links: ["/new"] }, "/new": {} }),
    });
    return { run, decisions };
  };

  it("is not exhausted when the discovery limit drops a link", async () => {
    const { run, decisions } = await continuedRun(await site());

    expect(decisions).toEqual(["accepted", "page_limit_reached"]);
    expect(run.frontierExhausted).toBe(false);
  });

  it("sizes the discovery limit from the whole crawl's page limit, counting what earlier runs discovered", async () => {
    const { run, decisions } = await continuedRun(await site(), 100);

    expect(decisions).toEqual(["accepted", "accepted"]);
    expect(run).toEqual({ pages: 2, frontierExhausted: true });
  });
});
