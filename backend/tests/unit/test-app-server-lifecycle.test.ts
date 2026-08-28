import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

const listenOnIpv4 = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve());
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

describe("test app HTTP lifecycle", () => {
  it("keeps one reachable listener across repeated requests", async () => {
    const { app } = createTestApp();

    for (let index = 0; index < 500; index += 1) {
      const response = await request(app).get("/health");
      expect(response.status).toBe(200);
    }
  });

  it("targets the actual family of an existing IPv4-only listener", async () => {
    const server = createHttpServer((_request, response) => {
      response.statusCode = 200;
      response.end("ok");
    });
    await listenOnIpv4(server);

    try {
      const response = await request(server).get("/");
      expect(response.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves HTTPS when deriving the address of a TLS listener", async () => {
    const server = createHttpsServer((_request, response) => {
      response.statusCode = 200;
      response.end("ok");
    });
    await listenOnIpv4(server);

    try {
      expect(request(server).get("/").url).toMatch(/^https:\/\/127\.0\.0\.1:/);
    } finally {
      await closeServer(server);
    }
  });
});
