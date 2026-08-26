import net from "node:net";

import { describe, expect, it } from "vitest";

import { RedisFaultProxy } from "../../support/realtime/redisFaultProxy.js";

const within = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`deadline exceeded after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const socketClosed = (socket: net.Socket): Promise<void> => {
  if (socket.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => socket.once("close", () => resolve()));
};

const listen = async (): Promise<{
  server: net.Server;
  sockets: Set<net.Socket>;
  port: number;
}> => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose an address");
  return { server, sockets, port: address.port };
};

const closeServer = async (server: net.Server, sockets: Set<net.Socket>): Promise<void> => {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await within(new Promise<void>((resolve) => server.close(() => resolve())), 250);
};

describe("RedisFaultProxy RED contract", () => {
  it("preserves password-only and escaped Redis URL credentials without double encoding", async () => {
    const passwordOnlyTarget = new URL("redis://:secret@127.0.0.1:1/2");
    const escapedTarget = new URL("redis://user%40name:p%40ss%3Aword@127.0.0.1:1/3");
    const passwordOnly = await RedisFaultProxy.start({ target: passwordOnlyTarget });
    const escaped = await RedisFaultProxy.start({ target: escapedTarget });
    try {
      const passwordOnlyUrl = new URL(passwordOnly.url);
      expect(passwordOnlyUrl.username).toBe(passwordOnlyTarget.username);
      expect.soft(passwordOnlyUrl.password).toBe(passwordOnlyTarget.password);
      expect(passwordOnlyUrl.pathname).toBe(passwordOnlyTarget.pathname);

      const escapedUrl = new URL(escaped.url);
      expect.soft(escapedUrl.username).toBe(escapedTarget.username);
      expect.soft(escapedUrl.password).toBe(escapedTarget.password);
      expect(escapedUrl.pathname).toBe(escapedTarget.pathname);
    } finally {
      await Promise.allSettled([passwordOnly.close(), escaped.close()]);
    }
  });

  it("closes the inbound peer when the target closes and fences concurrent proxy shutdown", async () => {
    const target = await listen();
    let proxy: RedisFaultProxy | undefined;
    let client: net.Socket | undefined;
    try {
      proxy = await RedisFaultProxy.start({ target: new URL(`redis://127.0.0.1:${target.port}`) });
      const accepted = new Promise<net.Socket>((resolve) => {
        const existing = [...target.sockets][0];
        if (existing) resolve(existing);
        else target.server.once("connection", resolve);
      });
      const proxyAddress = new URL(proxy.url);
      client = net.createConnection({
        host: "127.0.0.1",
        port: Number(proxyAddress.port),
      });
      client.on("error", () => undefined);
      await within(new Promise<void>((resolve, reject) => {
        client?.once("connect", resolve);
        client?.once("error", reject);
      }), 250);
      const targetSocket = await within(accepted, 250);
      const inboundClosed = socketClosed(client);
      targetSocket.destroy();
      await expect(within(inboundClosed, 250)).resolves.toBeUndefined();

      const firstClose = proxy.close();
      const secondClose = proxy.close();
      expect.soft(secondClose).toBe(firstClose);
      await expect(within(firstClose, 250)).resolves.toBeUndefined();
      await expect(within(secondClose, 250)).resolves.toBeUndefined();
    } finally {
      client?.destroy();
      if (proxy) await Promise.allSettled([proxy.close()]);
      await Promise.allSettled([closeServer(target.server, target.sockets)]);
    }
  });
});
