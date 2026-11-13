import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertPublicHttpUrl } from "../../src/shared/domain/publicNetwork.js";
import {
  fetchPublicBytes,
  type PublicBytesFetchFailure,
  type PublicBytesFetchResult,
  type PublicBytesLimits,
} from "../../src/shared/infra/http/publicBytesFetch.js";
import { createPublicUrlFetch } from "../../src/shared/infra/http/publicUrlFetch.js";

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const LIMITS: PublicBytesLimits = { timeoutMs: 2_000, maxBytes: 64 * 1024, contentTypePrefix: "image/", accept: "image/*" };

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A loopback server whose routes are set per test, recording each path it was asked for. */
const startServer = async (routes: () => ReadonlyMap<string, Handler>) => {
  const requested: string[] = [];
  const headers = new Map<string, IncomingMessage["headers"]>();
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requested.push(path);
    headers.set(path, request.headers);
    const handler = routes().get(path);
    if (handler) handler(request, response);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requested,
    headers,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

/** Lets the test server through, as the public policy would let a public host through; every other URL meets the real policy. */
const allowingOnly = (origin: string) => (url: string): URL => {
  const parsed = new URL(url);
  return parsed.origin === origin ? parsed : assertPublicHttpUrl(url);
};

const redirectTo = (location: string): Handler => (_request, response) => {
  response.writeHead(302, { location }).end();
};

const failedWith = (reason: PublicBytesFetchFailure, status?: number): PublicBytesFetchResult =>
  status === undefined ? { kind: "failed", reason } : { kind: "failed", reason, status };

describe("fetchPublicBytes", () => {
  let routes: ReadonlyMap<string, Handler> = new Map();
  let server: Awaited<ReturnType<typeof startServer>>;
  /** Stands in for a host on a private address: whatever reaches it was not re-checked. */
  let canary: Awaited<ReturnType<typeof startServer>>;
  /** Whether the streamed body was written to its end, or cut off by the reader. */
  let streamed: { finished: boolean; closedEarly: boolean };

  const transport = () => ({
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init),
    assertUrl: allowingOnly(server.origin),
  });

  beforeAll(async () => {
    server = await startServer(() => routes);
    canary = await startServer(() => new Map([["/photo", (_request, response) => response.writeHead(200, { "content-type": "image/jpeg" }).end(PHOTO)]]));
  });

  afterAll(async () => {
    await server.close();
    await canary.close();
  });

  beforeEach(() => {
    server.requested.length = 0;
    canary.requested.length = 0;
    streamed = { finished: false, closedEarly: false };
    routes = new Map<string, Handler>([
      ["/photo", (_request, response) => {
        response.writeHead(200, { "content-type": "image/jpeg", "content-length": String(PHOTO.length) }).end(PHOTO);
      }],
      ["/page", (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
      }],
      ["/gone", (_request, response) => {
        response.writeHead(410).end();
      }],
      ["/slow-headers", (_request, response) => {
        const timer = setTimeout(() => response.writeHead(200, { "content-type": "image/jpeg" }).end(PHOTO), 5_000);
        response.on("close", () => clearTimeout(timer));
      }],
      ["/slow-body", (_request, response) => {
        response.writeHead(200, { "content-type": "image/jpeg" });
        response.write(PHOTO.subarray(0, 4));
        const timer = setTimeout(() => response.end(PHOTO.subarray(4)), 5_000);
        response.on("close", () => clearTimeout(timer));
      }],
      ["/declared-large", (_request, response) => {
        response.writeHead(200, { "content-type": "image/jpeg", "content-length": String(LIMITS.maxBytes + 1) });
        response.end(Buffer.alloc(LIMITS.maxBytes + 1));
      }],
      ["/streamed-large", (_request, response) => {
        // No length declared: only the bytes actually read can stop it.
        response.writeHead(200, { "content-type": "image/jpeg" });
        let sent = 0;
        const total = 8 * 1024 * 1024;
        const chunk = Buffer.alloc(16 * 1024, 7);
        response.on("close", () => { if (!streamed.finished) streamed.closedEarly = true; });
        const pump = () => {
          while (sent < total) {
            sent += chunk.length;
            if (!response.write(chunk)) {
              response.once("drain", pump);
              return;
            }
          }
          streamed.finished = true;
          response.end();
        };
        pump();
      }],
      ["/tagged", (request, response) => {
        if (request.headers["if-none-match"] === '"v1"') {
          response.writeHead(304, { etag: '"v1"' }).end();
          return;
        }
        response.writeHead(200, { "content-type": "image/jpeg", etag: '"v1"' }).end(PHOTO);
      }],
      ["/to-photo", redirectTo("/photo")],
      ["/to-metadata", redirectTo("http://169.254.169.254/latest/meta-data/")],
      ["/to-private-host", redirectTo(`http://localhost:${new URL(canary.origin).port}/photo`)],
      ["/to-file", redirectTo("file:///etc/passwd")],
      ["/loop", redirectTo("/loop")],
      ["/to-nowhere", (_request, response) => {
        response.writeHead(302).end();
      }],
    ]);
  });

  it("returns the body, its content type and the URL it came from, asking for images", async () => {
    const result = await fetchPublicBytes(`${server.origin}/photo`, LIMITS, transport());

    expect(result).toEqual({ kind: "fetched", bytes: PHOTO, contentType: "image/jpeg", url: `${server.origin}/photo` });
    expect(server.headers.get("/photo")?.accept).toBe("image/*");
  });

  it("gives up when the headers do not arrive in time", async () => {
    const startedAt = Date.now();

    const result = await fetchPublicBytes(`${server.origin}/slow-headers`, { ...LIMITS, timeoutMs: 150 }, transport());

    expect(result).toEqual({ kind: "failed", reason: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("gives up when the body stalls past the same budget", async () => {
    const result = await fetchPublicBytes(`${server.origin}/slow-body`, { ...LIMITS, timeoutMs: 150 }, transport());

    expect(result).toEqual({ kind: "failed", reason: "timeout" });
  });

  it("refuses a body that declares more than the cap, without reading it", async () => {
    expect(await fetchPublicBytes(`${server.origin}/declared-large`, LIMITS, transport())).toEqual(failedWith("too_large"));
  });

  it("cuts off a body that outgrows the cap while streaming", async () => {
    const result = await fetchPublicBytes(`${server.origin}/streamed-large`, LIMITS, transport());

    expect(result).toEqual({ kind: "failed", reason: "too_large" });
    await expect.poll(() => streamed.closedEarly).toBe(true);
    expect(streamed.finished).toBe(false);
  });

  it("refuses a response whose content type is not the one asked for", async () => {
    expect(await fetchPublicBytes(`${server.origin}/page`, LIMITS, transport())).toEqual({ kind: "failed", reason: "content_type" });
  });

  it("reads any content type when no prefix is asked for", async () => {
    const result = await fetchPublicBytes(`${server.origin}/page`, { timeoutMs: 2_000, maxBytes: 1_024 }, transport());

    expect(result).toMatchObject({ kind: "fetched", contentType: "text/html" });
    expect(server.headers.get("/page")?.accept).toBe("*/*");
  });

  it("returns the entity tag a response carries, and reports an unchanged body when asked with it", async () => {
    const first = await fetchPublicBytes(`${server.origin}/tagged`, LIMITS, transport());
    const unchanged = await fetchPublicBytes(`${server.origin}/tagged`, { ...LIMITS, ifNoneMatch: '"v1"' }, transport());
    const changed = await fetchPublicBytes(`${server.origin}/tagged`, { ...LIMITS, ifNoneMatch: '"v0"' }, transport());

    expect(first).toEqual({ kind: "fetched", bytes: PHOTO, contentType: "image/jpeg", url: `${server.origin}/tagged`, etag: '"v1"' });
    expect(unchanged).toEqual({ kind: "not_modified", url: `${server.origin}/tagged` });
    expect(changed).toMatchObject({ kind: "fetched", etag: '"v1"' });
  });

  it("reports a status that is not a success", async () => {
    expect(await fetchPublicBytes(`${server.origin}/gone`, LIMITS, transport())).toEqual(failedWith("http_status", 410));
    expect(await fetchPublicBytes(`${server.origin}/to-nowhere`, LIMITS, transport())).toEqual({ kind: "failed", reason: "http_status", status: 302 });
  });

  it("follows a redirect the policy allows, and reports where the bytes came from", async () => {
    const result = await fetchPublicBytes(`${server.origin}/to-photo`, LIMITS, transport());

    expect(result).toEqual({ kind: "fetched", bytes: PHOTO, contentType: "image/jpeg", url: `${server.origin}/photo` });
    expect(server.requested).toEqual(["/to-photo", "/photo"]);
  });

  it("re-checks every redirect target, and never requests one the policy refuses", async () => {
    for (const path of ["/to-metadata", "/to-private-host", "/to-file"]) {
      expect(await fetchPublicBytes(`${server.origin}${path}`, LIMITS, transport())).toEqual({ kind: "failed", reason: "blocked" });
    }
    expect(canary.requested).toEqual([]);
  });

  it("stops after the redirects it allows", async () => {
    const result = await fetchPublicBytes(`${server.origin}/loop`, { ...LIMITS, maxRedirects: 2 }, transport());

    expect(result).toEqual({ kind: "failed", reason: "too_many_redirects" });
    expect(server.requested).toEqual(["/loop", "/loop", "/loop"]);
  });

  it("goes through the public transport by default, which refuses a loopback address", async () => {
    expect(await fetchPublicBytes(`${server.origin}/photo`, LIMITS)).toEqual({ kind: "failed", reason: "blocked" });
    expect(server.requested).toEqual([]);
  });

  it("is blocked when the public transport finds a name resolving to a private address", async () => {
    const privateAnswer = createPublicUrlFetch(async () => [{ address: "127.0.0.1", family: 4 }]);

    const result = await fetchPublicBytes(`http://images.example:${new URL(server.origin).port}/photo`, LIMITS, { fetch: privateAnswer });

    expect(result).toEqual({ kind: "failed", reason: "blocked" });
    expect(server.requested).toEqual([]);
  });
});
