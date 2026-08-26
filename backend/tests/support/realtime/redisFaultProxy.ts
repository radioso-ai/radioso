import net from "node:net";

type RedisFaultProxyInput = {
  target: URL;
};

type SocketPair = {
  client: net.Socket;
  clientClosed: boolean;
  upstream: net.Socket;
  upstreamClosed: boolean;
};

/**
 * A deliberately small test-only TCP proxy.  It cuts existing connections and
 * refuses new ones while cut, then resumes forwarding without restarting Redis.
 * The proxy never speaks Redis and therefore cannot hide protocol failures.
 */
export class RedisFaultProxy {
  private readonly server: net.Server;
  private readonly pairs = new Set<SocketPair>();
  private cutState = false;
  private listening: Promise<void>;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private addressValue: net.AddressInfo | undefined;

  private constructor(private readonly input: RedisFaultProxyInput) {
    this.server = net.createServer((client) => this.forward(client));
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: 0 }, () => {
        this.server.removeListener("error", reject);
        this.addressValue = this.server.address() as net.AddressInfo;
        resolve();
      });
    });
  }

  static async start(input: RedisFaultProxyInput): Promise<RedisFaultProxy> {
    if (input.target.protocol !== "redis:") {
      throw new Error("The realtime Redis fault proxy requires a redis:// target");
    }
    const proxy = new RedisFaultProxy(input);
    await proxy.listening;
    return proxy;
  }

  get url(): string {
    const address = this.addressValue;
    if (!address) throw new Error("Redis fault proxy is not listening");
    const credentials = this.input.target.username || this.input.target.password
      ? `${this.input.target.username}${this.input.target.password ? `:${this.input.target.password}` : ""}@`
      : "";
    return `redis://${credentials}127.0.0.1:${address.port}${this.input.target.pathname}${this.input.target.search}`;
  }

  async cut(): Promise<void> {
    if (this.closed) return;
    this.cutState = true;
    for (const pair of [...this.pairs]) this.destroyPair(pair);
    await Promise.resolve();
  }

  async restore(): Promise<void> {
    if (this.closed) return;
    this.cutState = false;
    await Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.cutState = true;
    for (const pair of [...this.pairs]) this.destroyPair(pair);
    this.closePromise = new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    return this.closePromise;
  }

  private forward(client: net.Socket): void {
    if (this.closed || this.cutState) {
      client.destroy();
      return;
    }
    const target = net.connect({ host: this.input.target.hostname.replace(/^\[|\]$/gu, ""), port: Number(this.input.target.port) || 6379 });
    const pair: SocketPair = { client, clientClosed: false, upstream: target, upstreamClosed: false };
    this.pairs.add(pair);
    client.once("close", () => {
      pair.clientClosed = true;
      this.destroyPair(pair);
      this.removeClosedPair(pair);
    });
    target.once("close", () => {
      pair.upstreamClosed = true;
      this.destroyPair(pair);
      this.removeClosedPair(pair);
    });
    client.on("error", () => this.destroyPair(pair));
    target.on("error", () => this.destroyPair(pair));
    client.pipe(target);
    target.pipe(client);
    target.once("connect", () => {
      if (this.cutState || this.closed) this.destroyPair(pair);
    });
  }

  private destroyPair(pair: SocketPair): void {
    pair.client.destroy();
    pair.upstream.destroy();
  }

  private removeClosedPair(pair: SocketPair): void {
    if (pair.clientClosed && pair.upstreamClosed) this.pairs.delete(pair);
  }
}
