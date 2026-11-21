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

    expect(decisions).toEqual(["page_limit_reached"]);
    expect(run.frontierExhausted).toBe(false);
  });

  it("sizes the discovery limit from the whole crawl's page limit, counting what earlier runs discovered", async () => {
    const { run, decisions } = await continuedRun(await site(), 100);

    expect(decisions).toEqual(["accepted"]);
    expect(run).toEqual({ pages: 2, frontierExhausted: true });
  });
});
