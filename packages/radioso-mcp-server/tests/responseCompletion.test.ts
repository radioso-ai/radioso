import { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessSessionRecord } from "../src/auth/sessionStore.js";
import { createExpressMcpMiddleware } from "../src/http/expressAdapter.js";
import { writeWebResponse } from "../src/http/nodeHttp.js";

const session: AccessSessionRecord = {
  accessTokenHash: "hash",
  converseSessionToken: "converse-session",
  expiresAt: new Date("2026-04-21T13:00:00.000Z"),
  issuedAt: new Date("2026-04-21T12:00:00.000Z"),
  sessionId: "session-1",
};

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
};

describe("standalone MCP response completion", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  });

  it("notifies only after a successful non-tool response has finished", async () => {
    const onSuccessfulResponse = vi.fn();
    let responseFinishedAtNotification = false;
    let activeResponse: ServerResponse | undefined;
    const middleware = createExpressMcpMiddleware(async (_request, sourceDigest) => ({
      response: Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }),
      successfulUse: { session, sourceDigest },
    }), {
      fallbackHost: "127.0.0.1",
      onSuccessfulResponse: (...args) => {
        responseFinishedAtNotification = activeResponse?.writableFinished === true;
        onSuccessfulResponse(...args);
      },
      sourceDigest: () => "source-digest",
    });
    const server = createServer((req, res) => {
      activeResponse = res;
      void middleware(req, res);
    });
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await vi.waitFor(() => expect(onSuccessfulResponse).toHaveBeenCalledOnce());

    expect(onSuccessfulResponse).toHaveBeenCalledWith(session, "source-digest");
    expect(responseFinishedAtNotification).toBe(true);
  });

  it.each([
    { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
    { jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } },
  ])("does not notify for failed or unsupported MCP responses", async (payload) => {
    const onSuccessfulResponse = vi.fn();
    const middleware = createExpressMcpMiddleware(async () => ({
      response: Response.json(payload),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), {
      fallbackHost: "127.0.0.1",
      onSuccessfulResponse,
    });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a result-only object", payload: { result: { tools: [] } } },
    { name: "a missing request id", payload: { jsonrpc: "2.0", result: { tools: [] } } },
    { name: "a missing JSON-RPC version", payload: { id: 1, result: { tools: [] } } },
  ])("does not notify for $name", async ({ payload }) => {
    const onSuccessfulResponse = vi.fn();
    const middleware = createExpressMcpMiddleware(async () => ({
      response: Response.json(payload),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it("does not notify for a bodyless 200 JSON response", async () => {
    const onSuccessfulResponse = vi.fn();
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "JSON-RPC error",
      payload: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
    },
    {
      name: "tool error result",
      payload: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } },
    },
  ])("does not notify for a completed SSE $name", async ({ payload }) => {
    const onSuccessfulResponse = vi.fn();
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it("notifies after a completed successful SSE response", async () => {
    const onSuccessfulResponse = vi.fn();
    const payload = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await vi.waitFor(() => expect(onSuccessfulResponse).toHaveBeenCalledWith(session, "source-digest"));
  });

  it("notifies after a CRLF-terminated successful SSE response", async () => {
    const onSuccessfulResponse = vi.fn();
    const payload = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(`event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await vi.waitFor(() => expect(onSuccessfulResponse).toHaveBeenCalledWith(session, "source-digest"));
  });

  it.each([202, 204])("notifies after a completed bodyless %i response", async (status) => {
    const onSuccessfulResponse = vi.fn();
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(null, { status }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

    expect(response.status).toBe(status);
    await vi.waitFor(() => expect(onSuccessfulResponse).toHaveBeenCalledWith(session, "source-digest"));
  });

  it("does not notify for an unterminated final SSE event", async () => {
    const onSuccessfulResponse = vi.fn();
    const payload = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(`event: message\ndata: ${JSON.stringify(payload)}`, {
        headers: { "content-type": "text/event-stream" },
      }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it("passes through responses over 8 MiB without notifying", async () => {
    const onSuccessfulResponse = vi.fn();
    const largeValue = "x".repeat(8 * 1024 * 1024 + 1);
    const payload = { jsonrpc: "2.0", id: 1, result: { value: largeValue } };
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(response.text()).resolves.toBe(body);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it.each(["synchronously", "asynchronously"] as const)(
    "does not change the completed response when notification persistence fails %s",
    async (failureMode) => {
      const onSuccessfulResponse = failureMode === "synchronously"
        ? vi.fn(() => { throw new Error("persistence unavailable"); })
        : vi.fn().mockRejectedValue(new Error("persistence unavailable"));
      const middleware = createExpressMcpMiddleware(async () => ({
        response: Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        successfulUse: { session, sourceDigest: "source-digest" },
      }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
      const server = createServer((req, res) => void middleware(req, res));
      servers.push(server);
      const port = await listen(server);

      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ result: { tools: [] } });
      await vi.waitFor(() => expect(onSuccessfulResponse).toHaveBeenCalledOnce());
    },
  );

  it("does not notify when the client disconnects after receiving a successful SSE event", async () => {
    const onSuccessfulResponse = vi.fn();
    const payload = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    const middleware = createExpressMcpMiddleware(async () => ({
      response: new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
          setTimeout(() => controller.close(), 100);
        },
      }), { headers: { "content-type": "text/event-stream" } }),
      successfulUse: { session, sourceDigest: "source-digest" },
    }), { fallbackHost: "127.0.0.1", onSuccessfulResponse });
    const server = createServer((req, res) => void middleware(req, res));
    servers.push(server);
    const port = await listen(server);

    await new Promise<void>((resolve, reject) => {
      const clientRequest = httpRequest({
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: { "content-type": "application/json" },
      }, (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      clientRequest.once("error", reject);
      clientRequest.end("{}");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onSuccessfulResponse).not.toHaveBeenCalled();
  });

  it("reports an incomplete response when the client closes before finish", async () => {
    class ClosingResponse extends EventEmitter {
      statusCode = 200;
      setHeader = vi.fn();
      end = vi.fn(() => queueMicrotask(() => this.emit("close")));
    }
    const response = new ClosingResponse();

    await expect(writeWebResponse(response as unknown as ServerResponse, new Response(null, { status: 204 })))
      .resolves.toBe(false);
  });
});
