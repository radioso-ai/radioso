import { once } from "node:events";
import { request } from "node:http";

import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("workspace events contract", () => {
  it("streams a ready frame and workspace-scoped identity-only push frames", async () => {
    const { app, dependencies } = createTestApp();
    const token = await issueTestToken(app, "workspace-events@example.com");
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }

    const frames = await new Promise<string>((resolve, reject) => {
      const stream = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/v1/events",
        headers: { authorization: `Bearer ${token.token}` },
      });
      let body = "";
      stream.on("response", (response) => {
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        expect(response.headers["x-accel-buffering"]).toBe("no");
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.includes("event: ready")) {
            void dependencies.workspaceEventBus.publish({
              resourceType: "document",
              resourceId: "document-other",
              workspaceId: "other-workspace",
              changeKind: "document.status_changed",
            });
            void dependencies.workspaceEventBus.publish({
              resourceType: "document",
              resourceId: "document-1",
              workspaceId: token.workspaceId,
              changeKind: "document.status_changed",
            });
          }
          if (body.includes("document-1")) {
            stream.destroy();
            resolve(body);
          }
        });
      });
      stream.on("error", reject);
      stream.end();
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(frames).toContain("event: ready");
    expect(frames).toContain("event: push");
    expect(frames).toContain('"resourceId":"document-1"');
    expect(frames).not.toContain("document-other");
    expect(frames).not.toContain("content");
  });

  it("releases the subscription when the client disconnects while ready() is pending", async () => {
    const { app, dependencies } = createTestApp();
    const token = await issueTestToken(app, "workspace-events-close@example.com");

    // Hold ready() open so we can disconnect strictly inside the await window,
    // and observe whether the route releases the bus subscription on close.
    let released = false;
    let resolveReady: () => void = () => {};
    const readyGate = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const bus = dependencies.workspaceEventBus;
    const realSubscribe = bus.subscribe.bind(bus);
    bus.subscribe = (workspaceId: string) => {
      const inner = realSubscribe(workspaceId);
      return {
        [Symbol.asyncIterator]() {
          const iterator = inner[Symbol.asyncIterator]();
          return {
            next: () => iterator.next(),
            return: async () => {
              released = true;
              return iterator.return ? iterator.return() : { done: true, value: undefined };
            },
          };
        },
      };
    };
    bus.ready = () => readyGate;

    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }

    await new Promise<void>((resolve) => {
      const stream = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/v1/events",
        headers: { authorization: `Bearer ${token.token}` },
      });
      stream.on("response", (response) => {
        expect(response.statusCode).toBe(200);
        // Disconnect while ready() is still pending, then let ready() resolve.
        stream.destroy();
        setTimeout(() => {
          resolveReady();
          setTimeout(resolve, 50);
        }, 100);
      });
      // A client-side abort after destroy() surfaces as an error; expected.
      stream.on("error", () => {});
      stream.end();
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(released).toBe(true);
  });
});
