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
});
