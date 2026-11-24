import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probePages } from "../../src/index.js";

type Answer = { status: number; location?: string; body?: string };

describe("asking a site about pages", () => {
  let servers: Server[] = [];
  const requests: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers = [];
    requests.length = 0;
  });

  /** A site that answers each path as it is told, and 404 otherwise. */
  const site = async (answers: Record<string, Answer>, options: { delayMs?: number; inFlight?: { now: number; most: number } } = {}) => {
    const server = createServer((req, res) => {
      const path = req.url ?? "";
      requests.push(path);
      const answer = answers[path] ?? { status: 404 };
      const inFlight = options.inFlight;
      if (inFlight && path !== "/robots.txt") {
        inFlight.now += 1;
        inFlight.most = Math.max(inFlight.most, inFlight.now);
      }
      setTimeout(() => {
        if (inFlight && path !== "/robots.txt") inFlight.now -= 1;
        res.writeHead(answer.status, answer.location ? { location: answer.location } : {}).end(answer.body ?? "page");
      }, options.delayMs ?? 0);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("reports the status and address that answered each page, after its redirects", async () => {
    const base = await site({
      "/alive": { status: 200 },
      "/gone": { status: 410 },
      "/moved": { status: 301, location: "/new-home" },
      "/new-home": { status: 200 },
      "/broken": { status: 503 },
    });

    const answers = await probePages(
      ["alive", "gone", "missing", "moved", "broken"].map((path) => `${base}/${path}`),
      {},
    );

    expect(answers).toEqual([
      { kind: "answered", status: 200, url: `${base}/alive` },
      { kind: "answered", status: 410, url: `${base}/gone` },
      { kind: "answered", status: 404, url: `${base}/missing` },
      { kind: "answered", status: 200, url: `${base}/new-home` },
      { kind: "answered", status: 503, url: `${base}/broken` },
    ]);
  });

  it("does not ask about a page robots.txt disallows, and reads robots.txt once per site", async () => {
    const base = await site({
      "/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private" },
      "/public": { status: 200 },
    });

    const answers = await probePages([`${base}/private/page`, `${base}/public`, `${base}/other`], {});

    expect(answers).toEqual([
      { kind: "unreachable" },
      { kind: "answered", status: 200, url: `${base}/public` },
      { kind: "answered", status: 404, url: `${base}/other` },
    ]);
    expect(requests.filter((path) => path === "/robots.txt")).toHaveLength(1);
    expect(requests).not.toContain("/private/page");
  });

  it("passes every hop to the navigation guard and reports a page the guard refuses as unreachable", async () => {
    const base = await site({ "/moved": { status: 302, location: "http://169.254.169.254/latest" } });
    const validateNavigationUrl = vi.fn((url: string) => {
      if (url.startsWith("http://169.254.169.254")) throw new Error("Blocked non-public target");
    });

    const answers = await probePages([`${base}/moved`], { validateNavigationUrl });

    expect(answers).toEqual([{ kind: "unreachable" }]);
    expect(validateNavigationUrl).toHaveBeenCalledWith(`${base}/moved`);
    expect(validateNavigationUrl).toHaveBeenCalledWith("http://169.254.169.254/latest");
  });

  it("reports a page whose site does not answer as unreachable", async () => {
    const base = await site({});
    const closed = servers.pop();
    await new Promise<void>((resolve) => closed?.close(() => resolve()));

    await expect(probePages([`${base}/page`], {})).resolves.toEqual([{ kind: "unreachable" }]);
  });

  it("asks about a few pages at a time", async () => {
    const inFlight = { now: 0, most: 0 };
    const base = await site({}, { delayMs: 20, inFlight });

    const answers = await probePages(Array.from({ length: 12 }, (_, index) => `${base}/page-${index}`), { concurrency: 3 });

    expect(answers).toHaveLength(12);
    expect(inFlight.most).toBeLessThanOrEqual(3);
    expect(inFlight.most).toBeGreaterThan(1);
  });

  it("reports every page as unreachable once the caller gives up", async () => {
    const base = await site({});
    const controller = new AbortController();
    controller.abort();

    await expect(probePages([`${base}/a`, `${base}/b`], { signal: controller.signal }))
      .resolves.toEqual([{ kind: "unreachable" }, { kind: "unreachable" }]);
  });
});
