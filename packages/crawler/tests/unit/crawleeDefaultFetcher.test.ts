import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crawlSite } from "../../src/index.js";

const CRAWLER_MAX_FETCH_RESPONSE_BYTES = 25 * 1024 * 1024;
const CRAWLER_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

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

  it("validates navigation URLs before fetching pages and robots.txt", async () => {
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

    const validateNavigationUrl = vi.fn();
    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1,
      validateNavigationUrl
    });

    expect(pages[0]).toEqual(expect.objectContaining({ status: "success" }));
    expect(validateNavigationUrl).toHaveBeenCalledWith(`${baseUrl}/robots.txt`);
    expect(validateNavigationUrl).toHaveBeenCalledWith(`${baseUrl}/`);
  });

  it("aborts a same-scope redirect when the navigation validator rejects the target", async () => {
    const hits: string[] = [];
    const { server, baseUrl } = await listen((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/start") {
        res.writeHead(302, { location: `${baseUrl}/start/private` }).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Private</title></head><body><main><p>Private content.</p></main></body></html>");
    });
    servers.push(server);

    const url = `${baseUrl}/start`;
    const validateNavigationUrl = vi.fn((candidateUrl: string) => {
      if (candidateUrl === `${baseUrl}/start/private`) {
        throw new Error("Blocked private target");
      }
    });

    const pages = await crawlSite({
      baseUrl: url,
      pageLimit: 1,
      validateNavigationUrl
    });

    expect(hits).toContain("/start");
    expect(hits).not.toContain("/start/private");
    expect(validateNavigationUrl).toHaveBeenCalledWith(url);
    expect(validateNavigationUrl).toHaveBeenCalledWith(`${baseUrl}/start/private`);
    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      frontierUrl: url,
      error: "Blocked private target"
    }));
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

  it("extracts the later contentful main when an earlier streamed main is empty", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html>
            <head><title>Streaming App</title></head>
            <body>
              <main aria-hidden="true"><div><span></span></div></main>
              <main>
                <h1>Contentful app page</h1>
                <p>The crawler should not stop at the empty shell.</p>
                <p>This page contains enough general body copy to represent a normal rendered marketing page, documentation page, or product page.</p>
                <p>The important behavior is independent of the domain: when a streamed application leaves an empty primary container before the real one, extraction should select the primary container that actually contains readable text.</p>
                <p>That keeps server-rendered content crawlable without requiring Playwright, cookies, or site-specific selectors.</p>
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

    expect(pages[0]).toEqual(expect.objectContaining({
      status: "success",
      text: [
        "# Contentful app page",
        "",
        "The crawler should not stop at the empty shell.",
        "",
        "This page contains enough general body copy to represent a normal rendered marketing page, documentation page, or product page.",
        "",
        "The important behavior is independent of the domain: when a streamed application leaves an empty primary container before the real one, extraction should select the primary container that actually contains readable text.",
        "",
        "That keeps server-rendered content crawlable without requiring Playwright, cookies, or site-specific selectors."
      ].join("\n"),
      skipReason: null
    }));
  });

  it("falls back to a plain fetch when the Crawlee HTTP client connection is reset before a response", async () => {
    let pageAttempts = 0;
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/next") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>Next</title></head><body><main><p>Next page content.</p></main></body></html>");
        return;
      }
      pageAttempts += 1;
      if (pageAttempts === 1) {
        req.socket.destroy();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Fallback</title></head><body><main><p>Fallback content.</p><a href=\"/next\">Next</a></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 2,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(pageAttempts).toBe(2);
    expect(pages.map((page) => page.url).sort()).toEqual([
      `${baseUrl}/`,
      `${baseUrl}/next`,
    ].sort());
    expect(pages[0]).toEqual(expect.objectContaining({
      status: "success",
      text: `Fallback content.\n\n[Next](${baseUrl}/next)`,
      httpAttempted: true,
      transportUsed: "http"
    }));
  });

  it("fails plain fetch pages when content-length exceeds the crawler response cap", async () => {
    let pageAttempts = 0;
    const html = Buffer.from("<html><head><title>Too large</title></head><body><main><p>Too large.</p></main></body></html>");
    const oversizedBody = Buffer.concat([
      html,
      Buffer.alloc(CRAWLER_MAX_FETCH_RESPONSE_BYTES + 1 - html.length, " ")
    ]);
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      pageAttempts += 1;
      if (pageAttempts === 1) {
        req.socket.destroy();
        return;
      }
      res
        .writeHead(200, {
          "content-length": String(oversizedBody.length),
          "content-type": "text/html; charset=utf-8"
        })
        .end(oversizedBody);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pageAttempts).toBe(2);
    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      links: [],
      error: expect.stringContaining("exceeds the 26214400 byte response limit")
    }));
  });

  it("fails when gzip-compressed robots.txt exceeds the decompressed text cap", async () => {
    let pageAttempts = 0;
    const compressedRobots = gzipSync(Buffer.alloc(CRAWLER_MAX_DECOMPRESSED_BYTES + 1, "a"));
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end(compressedRobots);
        return;
      }
      pageAttempts += 1;
      if (pageAttempts === 1) {
        req.socket.destroy();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Bomb</title></head><body><main><p>Bomb page.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      links: [],
      error: expect.stringContaining("exceeds the 52428800 byte decompressed response limit")
    }));
  });

  it("does not use the plain fetch fallback to bypass robots.txt", async () => {
    let pageHits = 0;
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("User-agent: ExampleDocsCrawler/1.0\nDisallow: /\n");
        return;
      }
      pageHits += 1;
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Blocked</title></head><body><main><p>Robots-blocked content.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(pageHits).toBe(0);
    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      links: [],
      error: "Blocked by robots.txt"
    }));
  });

  it("does not use the plain fetch fallback to bypass robots.txt after redirects", async () => {
    let startAttempts = 0;
    let privateHits = 0;
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("User-agent: ExampleDocsCrawler/1.0\nAllow: /start\nDisallow: /start/private\n");
        return;
      }
      if (req.url === "/start") {
        startAttempts += 1;
        if (startAttempts === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(302, { location: "/start/private" }).end();
        return;
      }
      if (req.url === "/start/private") {
        privateHits += 1;
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>Private</title></head><body><main><p>Private content.</p></main></body></html>");
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl: `${baseUrl}/start`,
      pageLimit: 1,
      userAgent: "ExampleDocsCrawler/1.0 (+https://example.com/crawler)"
    });

    expect(startAttempts).toBe(2);
    expect(privateHits).toBe(0);
    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      error: "Blocked by robots.txt"
    }));
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

  it("preserves content link and embedded video URLs in extracted text", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html>
            <head><title>Lesson</title></head>
            <body>
              <header>
                <a href="/menu">Menu</a>
                <iframe src="https://www.youtube.com/embed/header-video"></iframe>
              </header>
              <main>
                <h1>Lesson</h1>
                <p>Read <a href="/resources/holy-science"><em>The Holy Science</em></a> before class.</p>
                <iframe
                  src="about:blank"
                  data-lazy-src="https://www.youtube.com/embed/z1ktOP09oLM?rel=0&amp;autoplay=1"
                ></iframe>
                <p>Then watch <a href="https://youtu.be/follow-up">the follow-up video</a>.</p>
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

    expect(pages[0].text).toContain(`Read [The Holy Science](${baseUrl}/resources/holy-science) before class.`);
    expect(pages[0].text).toContain("Video: https://www.youtube.com/watch?v=z1ktOP09oLM");
    expect(pages[0].text).toContain("Then watch [the follow-up video](https://youtu.be/follow-up).");
    expect(pages[0].text).not.toContain("header-video");
    expect(pages[0].text).not.toContain("Menu");
  });

  it("can render content links as plain text while still dropping share and tracking links", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html>
            <head><title>Lesson</title></head>
            <body>
              <main>
                <p>Read <a href="/resources?utm_source=newsletter">the resource</a>.</p>
                <p>Share <a href="https://facebook.com/sharer/sharer.php?u=https://example.com">Facebook</a>.</p>
                <iframe src="https://www.youtube.com/embed/z1ktOP09oLM"></iframe>
              </main>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1,
      preserveContentLinks: false
    });

    expect(pages[0].text).toContain("Read the resource.");
    expect(pages[0].text).toContain("Share Facebook.");
    expect(pages[0].text).not.toContain("utm_source");
    expect(pages[0].text).not.toContain("facebook.com");
    expect(pages[0].text).not.toContain("youtube.com");
  });

  it("applies include and exclude URL patterns with deny taking precedence", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/docs/keep") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>Keep</title></head><body><main><p>Keep documentation with enough practical explanation to pass quality scoring. This page describes setup steps, troubleshooting details, operational constraints, configuration ownership, release verification, support routing, and maintenance expectations for the documentation area. It also explains expected user permissions, migration order, rollback criteria, logging checks, and handoff notes so operators can use the material as durable reference content rather than a sparse navigation stub.</p></main></body></html>");
        return;
      }
      if (req.url === "/docs/private" || req.url === "/blog/post") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>Denied</title></head><body><main><p>Denied content.</p></main></body></html>");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html><head><title>Home</title></head><body><main>
            <p>Home content.</p>
            <a href="/docs/keep">Keep</a>
            <a href="/docs/private">Private</a>
            <a href="/blog/post">Blog</a>
          </main></body></html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 4,
      includeUrlPatterns: ["/docs/"],
      excludeUrlPatterns: ["private"]
    });

    expect(pages.map((page) => page.url).sort()).toEqual([
      `${baseUrl}/`,
      `${baseUrl}/docs/keep`,
    ].sort());
    expect(pages.find((page) => page.url === `${baseUrl}/`)).toEqual(expect.objectContaining({
      skipReason: "Skipped by include URL policy"
    }));
    expect(pages.find((page) => page.url === `${baseUrl}/docs/keep`)?.skipReason).toBeNull();
    expect(pages.map((page) => page.text).join("\n")).not.toContain("Denied content");
  });

  it("marks structurally link-dense pages as discovery-only listing pages", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/indexes/news") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(`
            <html><head><title>News Index</title></head><body>
              <a href="/news/story">A full story</a>
              <a href="/news/second">Another story</a>
              <a href="/news/third">Third story</a>
              <a href="/news/fourth">Fourth story</a>
              <a href="/news/fifth">Fifth story</a>
              <a href="/news/sixth">Sixth story</a>
              <a href="/news/seventh">Seventh story</a>
              <a href="/news/eighth">Eighth story</a>
            </body></html>
          `);
        return;
      }
      if (req.url === "/") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>Home</title></head><body><main><a href=\"/indexes/news\">News index</a></main></body></html>");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Story</title></head><body><article><p>Detailed story content with enough words to pass extraction scoring.</p></article></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 3
    });
    const listingPage = pages.find((page) => page.url === `${baseUrl}/indexes/news`);

    expect(listingPage).toEqual(expect.objectContaining({
      pageType: "listing",
      skipReason: "Skipped listing page"
    }));
    expect(pages.map((page) => page.url)).toContain(`${baseUrl}/news/story`);
  });

  it("does not skip content only because the path contains index-like words", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/category/security-guide") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(`
            <html><head><title>Security Guide</title></head><body>
              <article><p>This security guide explains how administrators should evaluate access boundaries, rotate operational credentials, document emergency procedures, and verify that monitoring covers the full deployment path. It includes practical guidance for rollout planning, maintenance windows, ownership checks, audit review, incident follow-up, and regular validation of assumptions across teams.</p></article>
            </body></html>
          `);
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><head><title>Home</title></head><body><main><a href=\"/category/security-guide\">Security guide</a></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 2
    });
    const contentPage = pages.find((page) => page.url === `${baseUrl}/category/security-guide`);

    expect(contentPage).toEqual(expect.objectContaining({
      pageType: "content",
      skipReason: null
    }));
  });

  it("keeps main content when utility classes contain navigation-like breakpoint names", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url === "/what-we-do") {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>Services</title></head><body><main><p>Service detail content.</p></main></body></html>");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html>
            <head><title>Utility Classes</title></head>
            <body>
              <header class="header nav:h-25">
                <nav><a href="/menu-only">Menu only</a></nav>
              </header>
              <main class="nav:mt-25">
                <h1>Ready to take your business venture to the next level?</h1>
                <p>We build large-scale software solutions for financial companies.</p>
                <a href="/what-we-do">What we do</a>
              </main>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 2
    });

    expect(pages.map((page) => page.url).sort()).toEqual([
      `${baseUrl}/`,
      `${baseUrl}/what-we-do`,
    ].sort());
    expect(pages[0].text).toContain("Ready to take your business venture to the next level?");
    expect(pages[0].text).toContain("We build large-scale software solutions");
  });

  it("keeps primary content inside containers with page chrome layout classes", async () => {
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
            <body class="header-width-full tweak-fixed-header-style-basic">
              <div class="page-shell header-overlay-alignment-center">
                <div class="site-header"><a href="/contact">Contact</a></div>
                <main>
                  <h1>A simple, clinically reliable headache diary.</h1>
                  <p>Headache App helps patients record headache episodes quickly.</p>
                </main>
              </div>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0].text).toContain("A simple, clinically reliable headache diary.");
    expect(pages[0].text).toContain("Headache App helps patients record headache episodes quickly.");
    expect(pages[0].text).not.toContain("Contact");
  });

  it("still strips non-semantic page chrome blocks with high-confidence classes", async () => {
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
              <div class="site-header"><article><a href="/hidden">Hidden navigation</a></article></div>
              <main><p>Visible clinical content.</p></main>
              <div id="footer-wrapper">Legal footer copy</div>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0].text).toBe("Visible clinical content.");
  });

  it("strips multi-part non-semantic chrome classes without matching layout classes", async () => {
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
            <body class="header-width-full">
              <div class="mobile-menu-search">Search menu copy</div>
              <div class="header-overlay-bar-style">Overlay menu copy</div>
              <main><p>Clinical content remains available.</p></main>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0].text).toBe("Clinical content remains available.");
  });

  it("strips prefix-only non-semantic chrome classes before body fallback extraction", async () => {
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
              <div class="site-header">Header navigation copy</div>
              <div class="desktop-menu">Desktop menu copy</div>
              <div class="mobile-footer">Mobile footer copy</div>
              <section><p>Body fallback content remains readable.</p></section>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0].text).toBe("Body fallback content remains readable.");
  });

  it("keeps link-card content inside the main page content", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      if (req.url?.startsWith("/news/")) {
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(`<html><head><title>News</title></head><body><main><p>News detail ${req.url}</p></main></body></html>`);
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`
          <html>
            <head><title>Link Card Home</title></head>
            <body>
              <header><nav><a href="/schedule">Schedule</a></nav></header>
              <main>
                <div class="featured-card-grid">
                  <a href="/news/inside-ferrari">Inside Ferrari and Red Bull's wing changes</a>
                  <a href="/news/sim-racing">Watch round seven of the racing championship</a>
                  <a href="/news/quiz">Quiz: name the champion from the year</a>
                  <a href="/news/audi">McNish on stepping into the hot seat at Audi</a>
                  <a href="/news/antonelli">How Antonelli made the best points start in years</a>
                  <a href="/news/button">Jenson Button revisits his maiden win after twenty years</a>
                </div>
              </main>
              <footer><a href="/privacy">Privacy</a></footer>
            </body>
          </html>
        `);
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 2
    });

    expect(pages[0].text).toContain("Inside Ferrari and Red Bull's wing changes");
    expect(pages[0].text).toContain("Jenson Button revisits his maiden win");
    expect(pages.map((page) => page.url)).toContain(`${baseUrl}/news/inside-ferrari`);
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

  it("preserves the status code for failed HTTP responses", async () => {
    const { server, baseUrl } = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(503, { "content-type": "text/html; charset=utf-8" })
        .end("<html><body><main><p>Maintenance page should not be ingested.</p></main></body></html>");
    });
    servers.push(server);

    const pages = await crawlSite({
      baseUrl,
      pageLimit: 1
    });

    expect(pages[0]).toEqual(expect.objectContaining({
      status: "failed",
      text: "",
      html: "",
      httpStatus: 503
    }));
    expect(pages[0].error).toContain("503");
  });
});
