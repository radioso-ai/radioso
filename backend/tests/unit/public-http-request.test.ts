import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertPublicHttpUrl } from "../../src/shared/domain/publicNetwork.js";
import {
  sendPublicHttpRequest,
  type PublicHttpRequestLimits,
} from "../../src/shared/infra/http/publicHttpRequest.js";

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

interface Received {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A loopback server whose routes are set per test, recording every request it was sent. */
const startServer = async (routes: () => ReadonlyMap<string, Handler>) => {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: request.method ?? "", path, headers: request.headers, body });
      const handler = routes().get(path);
      if (handler) handler(request, body, response);
      else response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    received,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

/** Lets the test server through, as the public policy would let a public host through; any other URL meets the real policy. */
const allowingOnly = (origin: string) => (url: string): URL => {
  const parsed = new URL(url);
  return parsed.origin === origin ? parsed : assertPublicHttpUrl(url);
};

const json = (status: number, value: unknown): Handler => (_request, _body, response) => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
};

const redirectTo = (location: string, status = 302): Handler => (_request, _body, response) => {
  response.writeHead(status, { location }).end();
};

const LIMITS: PublicHttpRequestLimits = { timeoutMs: 2_000, maxResponseBytes: 64 * 1024 };

describe("sendPublicHttpRequest", () => {
  let routes: ReadonlyMap<string, Handler> = new Map();
  let server: Awaited<ReturnType<typeof startServer>>;
  /** Stands in for another origin: whatever reaches it followed a redirect it should not have. */
  let other: Awaited<ReturnType<typeof startServer>>;

  const transport = () => ({
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init),
    assertUrl: allowingOnly(server.origin),
  });

  beforeAll(async () => {
    server = await startServer(() => routes);
    other = await startServer(() => new Map([["/landing", json(200, { reached: true })]]));
  });

  afterAll(async () => {
    await server.close();
    await other.close();
  });

  beforeEach(() => {
    routes = new Map();
    server.received.length = 0;
    other.received.length = 0;
  });

  it("sends a GET and returns the status, body, content type and duration", async () => {
    routes = new Map([["/orders/1?expand=items", json(200, { order: { status: "shipped" } })]]);

    const result = await sendPublicHttpRequest(
      { method: "GET", url: `${server.origin}/orders/1?expand=items`, headers: { accept: "application/json" } },
      LIMITS,
      transport(),
    );

    expect(result).toMatchObject({ kind: "response", status: 200, contentType: "application/json" });
    if (result.kind !== "response") throw new Error("expected a response");
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({ order: { status: "shipped" } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(server.received[0]).toMatchObject({ method: "GET", path: "/orders/1?expand=items" });
    expect(server.received[0].headers.accept).toBe("application/json");
  });

  it("sends the method, headers and body it is given", async () => {
    routes = new Map([["/tickets", json(201, { id: "t-1" })]]);

    const result = await sendPublicHttpRequest(
      {
        method: "POST",
        url: `${server.origin}/tickets`,
        headers: { "content-type": "application/json", authorization: "Bearer token-1" },
        body: JSON.stringify({ customer: { email: "visitor@example.com" } }),
      },
      LIMITS,
      transport(),
    );

    expect(result).toMatchObject({ kind: "response", status: 201 });
    expect(server.received[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ customer: { email: "visitor@example.com" } }),
    });
    expect(server.received[0].headers.authorization).toBe("Bearer token-1");
  });

  it("returns a non-2xx answer with its body rather than failing", async () => {
    routes = new Map([["/orders/9", json(422, { error: "invalid" })]]);

    const result = await sendPublicHttpRequest({ method: "PUT", url: `${server.origin}/orders/9`, body: "{}" }, LIMITS, transport());

    expect(result).toMatchObject({ kind: "response", status: 422 });
    if (result.kind !== "response") throw new Error("expected a response");
    expect(result.body.toString("utf8")).toBe('{"error":"invalid"}');
  });

  it("refuses a body over the cap, declared or streamed", async () => {
    const big = "x".repeat(2_000);
    routes = new Map<string, Handler>([
      ["/declared", (_request, _body, response) => response.writeHead(200, { "content-length": String(big.length) }).end(big)],
      ["/streamed", (_request, _body, response) => {
        response.writeHead(200);
        response.write(big.slice(0, 1_000));
        response.end(big.slice(1_000));
      }],
    ]);
    const limits = { ...LIMITS, maxResponseBytes: 1_500 };

    expect(await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/declared` }, limits, transport()))
      .toMatchObject({ kind: "failed", reason: "too_large" });
    expect(await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/streamed` }, limits, transport()))
      .toMatchObject({ kind: "failed", reason: "too_large" });
  });

  it("gives up at the deadline", async () => {
    routes = new Map<string, Handler>([["/slow", () => undefined]]);

    const result = await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/slow` }, { ...LIMITS, timeoutMs: 150 }, transport());

    expect(result).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  it("follows a same-origin redirect for a GET", async () => {
    routes = new Map([
      ["/old", redirectTo("/new")],
      ["/new", json(200, { moved: true })],
    ]);

    const result = await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/old` }, LIMITS, transport());

    expect(result).toMatchObject({ kind: "response", status: 200 });
    expect(server.received.map((entry) => entry.path)).toEqual(["/old", "/new"]);
  });

  it("refuses a redirect to another origin without requesting it", async () => {
    routes = new Map([["/away", redirectTo(`${other.origin}/landing`)]]);

    const result = await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/away` }, LIMITS, transport());

    expect(result).toMatchObject({ kind: "failed", reason: "redirect_refused", status: 302 });
    expect(other.received).toHaveLength(0);
  });

  it("refuses any redirect for a request that is not a GET", async () => {
    routes = new Map([
      ["/submit", redirectTo("/submitted", 307)],
      ["/submitted", json(200, { ok: true })],
    ]);

    const result = await sendPublicHttpRequest({ method: "POST", url: `${server.origin}/submit`, body: "{}" }, LIMITS, transport());

    expect(result).toMatchObject({ kind: "failed", reason: "redirect_refused", status: 307 });
    expect(server.received.map((entry) => entry.path)).toEqual(["/submit"]);
  });

  it("stops after three redirects", async () => {
    routes = new Map([
      ["/r0", redirectTo("/r1")],
      ["/r1", redirectTo("/r2")],
      ["/r2", redirectTo("/r3")],
      ["/r3", redirectTo("/r4")],
      ["/r4", json(200, {})],
    ]);

    const result = await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/r0` }, LIMITS, transport());

    expect(result).toMatchObject({ kind: "failed", reason: "too_many_redirects" });
    expect(server.received).toHaveLength(4);
  });

  it("refuses a private address under the default policy without sending", async () => {
    routes = new Map([["/private", json(200, {})]]);

    const result = await sendPublicHttpRequest({ method: "GET", url: `${server.origin}/private` }, LIMITS);

    expect(result).toMatchObject({ kind: "failed", reason: "blocked" });
    expect(server.received).toHaveLength(0);
  });

  it("sends plain http to this machine only where loopback is allowed", async () => {
    routes = new Map([["/local", json(200, { local: true })]]);
    const localUrl = `${server.origin.replace("127.0.0.1", "localhost")}/local`;

    expect(await sendPublicHttpRequest({ method: "GET", url: localUrl }, LIMITS))
      .toMatchObject({ kind: "failed", reason: "blocked" });
    expect(await sendPublicHttpRequest({ method: "GET", url: localUrl }, LIMITS, { allowHttpLoopback: true }))
      .toMatchObject({ kind: "response", status: 200 });
  });

  it("reports a host that does not answer as unreachable", async () => {
    const closed = await startServer(() => new Map());
    const closedOrigin = closed.origin;
    await closed.close();

    const result = await sendPublicHttpRequest({ method: "GET", url: `${closedOrigin}/x` }, LIMITS, {
      fetch: (input, init) => globalThis.fetch(input, init),
      assertUrl: (url) => new URL(url),
    });

    expect(result).toMatchObject({ kind: "failed", reason: "unreachable" });
  });
});
