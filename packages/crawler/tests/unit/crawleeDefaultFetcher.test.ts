import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { crawlSite } from "../../src/index.js";

const listen = async (
  handler: Parameters<typeof createServer>[0]
): Promise<{ server: Server; baseUrl: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
};

const closeServer = async (server: Server) => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
};

describe("default Crawlee fetcher", () => {
  let servers: Server[] = [];
  const originalPath = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(servers.map(closeServer));
    servers = [];
  });

  it("rejects out-of-scope redirects before fetching the redirected URL", async () => {
    const hits: string[] = [];
    const { server, baseUrl } = await listen((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/start") {
        res.writeHead(302, { location: `${baseUrl}/private` }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<html>private</html>");
    });
    servers.push(server);

    const url = `${baseUrl}/start`;
    const pages = await crawlSite({
      baseUrl: url,
      pageLimit: 1
    });

    expect(hits).toContain("/start");
    expect(hits).not.toContain("/private");
    expect(pages[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        frontierUrl: url
      })
    );
  });

  it("still crawls when PATH omits standard system binary directories", async () => {
    process.env.PATH = "/path-without-system-binaries";
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Minimal</title></head><body><main><p>Reachable content.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0]).toEqual(
      expect.objectContaining({
        status: "success",
        text: "Reachable content."
      })
    );
  });

  it("stores decoded readable text with structural line breaks", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html>
            <head><title>Clinic</title></head>
            <body>
              <main>
                <h1><span>Peavalu</span><span>&amp; ravi</span></h1>
                <p>Patsient &#xF5;pib p&auml;evikut.</p>
                <section>
                  <div>Vastuvõtt ja nõustamine</div>
                  <div>Broneeri aeg enne külastust.</div>
                </section>
                <blockquote><p>Küsi abi, kui sümptomid süvenevad.</p></blockquote>
                <p>Broken entity stays readable: &#1114112; and &#x110000;.</p>
                <ul>
                  <li><span>Esimene</span><span>samm</span></li>
                  <li>Teine samm</li>
                </ul>
              </main>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0].text).toContain("# Peavalu & ravi");
    expect(pages[0].text).toContain("Patsient õpib päevikut.");
    expect(pages[0].text).toContain("Vastuvõtt ja nõustamine\n\nBroneeri aeg enne külastust.");
    expect(pages[0].text).toContain("> Küsi abi, kui sümptomid süvenevad.");
    expect(pages[0].text).toContain("Broken entity stays readable: � and �.");
    expect(pages[0].text).toContain("- Esimene samm\n- Teine samm");
    expect(pages[0].text).not.toContain("Peavalu& ravi");
    expect(pages[0].text).not.toContain("Esimenesamm");
    expect(pages[0].text).not.toContain("&#xF5;");
    expect(pages[0].text).not.toContain("&auml;");
  });

  it("sends the configured user agent when fetching pages", async () => {
    const userAgents = new Map<string, string | undefined>();
    const { server, baseUrl } = await listen((req, res) => {
      userAgents.set(req.url ?? "", req.headers["user-agent"]);
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Docs</title></head><body><main><p>Docs content.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(pages[0]).toEqual(expect.objectContaining({ status: "success" }));
    expect(userAgents.get("/")).toBe("ExampleDocsCrawler/1.0 (+https://example.com/crawler)");
  });

  it("seeds pages from robots.txt sitemaps when the landing page has no body links", async () => {
    const hits: string[] = [];
    const { server, baseUrl } = await listen((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/robots.txt") {
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
        return;
      }
      if (req.url === "/sitemap.xml") {
        res
          .writeHead(200, { "content-type": "application/xml; charset=utf-8" })
          .end(`<?xml version="1.0" encoding="UTF-8"?>
            <urlset>
              <url><loc>${baseUrl}/about</loc></url>
              <url><loc>${baseUrl}/faq</loc></url>
              <url><loc>https://other.example/ignored</loc></url>
            </urlset>
          `);
        return;
      }
      if (req.url === "/about") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>About</title></head><body><main><p>About content.</p></main></body></html>");
        return;
      }
      if (req.url === "/faq") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>FAQ</title></head><body><main><p>FAQ content.</p></main></body></html>");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`<html><head><title>Home</title></head><body>
          <header><nav><a href="/about">About</a><a href="/faq">FAQ</a></nav></header>
          <main><p>Home content.</p></main>
        </body></html>`);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 3
    });

    expect(hits).toContain("/sitemap.xml");
    expect(pages.map((page) => page.url).sort()).toEqual([
      `${baseUrl}/about`,
      `${baseUrl}/faq`,
      `${baseUrl}/`,
    ].sort());
    expect(pages.map((page) => page.text)).toEqual(
      expect.arrayContaining(["Home content.", "About content.", "FAQ content."])
    );
  });

  it("sends the configured user agent when fetching robots.txt and sitemaps", async () => {
    const userAgentsByPath = new Map<string, string[]>();
    const recordUserAgent = (path: string, userAgent: string | undefined) => {
      userAgentsByPath.set(path, [...(userAgentsByPath.get(path) ?? []), userAgent ?? ""]);
    };
    const { server, baseUrl } = await listen((req, res) => {
      const path = req.url ?? "";
      recordUserAgent(path, req.headers["user-agent"]);
      if (path === "/robots.txt") {
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end(`User-agent: ExampleDocsCrawler/1.0\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
        return;
      }
      if (path === "/sitemap.xml") {
        res
          .writeHead(200, { "content-type": "application/xml; charset=utf-8" })
          .end(`<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>${baseUrl}/about</loc></url></urlset>`);
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>About</title></head><body><main><p>About content.</p></main></body></html>");
    });
    servers.push(server);

    await crawlSite({
      baseUrl,
      pageLimit: 1,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(userAgentsByPath.get("/robots.txt")).toContain("ExampleDocsCrawler/1.0 (+https://example.com/crawler)");
    expect(userAgentsByPath.get("/sitemap.xml")).toContain("ExampleDocsCrawler/1.0 (+https://example.com/crawler)");
  });

  it("treats a 403 response as a failed blocked page without content", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(403, { "content-type": "text/html; charset=utf-8" })
        .end("<html><body><main><p>Blocked content must not be ingested.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      html: "",
      httpStatus: 403,
      error: "Blocked by status code 403"
    }));
  });

  it("treats a 429 response as blocked and reports Retry-After", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(429, {
          "content-type": "text/html; charset=utf-8",
          "retry-after": "120"
        })
        .end("<html><body><main><p>Rate limit page must not be ingested.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      html: "",
      httpStatus: 429,
      error: "Blocked by status code 429 (Retry-After: 120)"
    }));
  });
});
