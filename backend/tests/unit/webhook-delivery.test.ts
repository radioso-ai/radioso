import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FetchWebhookHttpClient,
  createSignedWebhookHeaders,
  verifyWebhookSignature,
} from "../../src/modules/webhooks/delivery.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook delivery signing", () => {
  it("signs the raw body with timestamped HMAC headers and verifies the same bytes", () => {
    const rawBody = JSON.stringify({ data: { email: "alex@example.com" } });
    const timestamp = "1781200000";
    const headers = createSignedWebhookHeaders({
      rawBody,
      secret: "receiver-secret",
      idempotencyKey: "routine-action:conv_1:webhook.send:hash",
      timestamp,
    });

    const expectedDigest = createHmac("sha256", "receiver-secret")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    expect(headers).toEqual({
      "Idempotency-Key": "routine-action:conv_1:webhook.send:hash",
      "X-Radioso-Timestamp": timestamp,
      "X-Radioso-Signature": `sha256=${expectedDigest}`,
    });
    expect(verifyWebhookSignature({
      rawBody,
      secret: "receiver-secret",
      timestamp,
      signatureHeader: headers["X-Radioso-Signature"],
    })).toBe(true);
  });

  it("rejects tampered bodies and wrong secrets", () => {
    const rawBody = JSON.stringify({ data: { email: "alex@example.com" } });
    const timestamp = "1781200000";
    const headers = createSignedWebhookHeaders({
      rawBody,
      secret: "receiver-secret",
      idempotencyKey: "idempotency-1",
      timestamp,
    });

    expect(verifyWebhookSignature({
      rawBody: JSON.stringify({ data: { email: "mallory@example.com" } }),
      secret: "receiver-secret",
      timestamp,
      signatureHeader: headers["X-Radioso-Signature"],
    })).toBe(false);
    expect(verifyWebhookSignature({
      rawBody,
      secret: "wrong-secret",
      timestamp,
      signatureHeader: headers["X-Radioso-Signature"],
    })).toBe(false);
  });
});

describe("FetchWebhookHttpClient", () => {
  const fetchThroughGlobal: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const redirect = (location: string | null, status = 307): Response =>
    new Response(null, {
      status,
      headers: location ? { location } : undefined,
    });

  it("re-validates a same-origin redirect hop before following it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect("/next"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const assertPublicUrl = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchWebhookHttpClient(assertPublicUrl, { fetchImpl: fetchThroughGlobal });
    await client.post({
      url: "https://hooks.example.com/start",
      rawBody: "{}",
      headers: { "X-Test": "1" },
    });

    expect(assertPublicUrl).toHaveBeenNthCalledWith(1, "https://hooks.example.com/start");
    expect(assertPublicUrl).toHaveBeenNthCalledWith(2, "https://hooks.example.com/next");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the connection-bound fetch supplied by composition", async () => {
    const globalFetch = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", globalFetch);

    const client = new FetchWebhookHttpClient(async () => undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.post({
      url: "https://hooks.example.com/start",
      rawBody: "{}",
      headers: {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("allows explicit local loopback delivery without running the public-url guard", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    const assertPublicUrl = vi.fn(async () => {
      throw new Error("loopback should bypass the public-url guard when explicitly allowed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchWebhookHttpClient(assertPublicUrl, { allowHttpLoopback: true });
    await client.post({
      url: "http://127.0.0.1:3001/api/radioso/commerce",
      rawBody: "{}",
      headers: { "X-Test": "1" },
    });

    expect(assertPublicUrl).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows explicit Docker host delivery without running the public-url guard", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    const assertPublicUrl = vi.fn(async () => {
      throw new Error("Docker host alias should bypass the public-url guard when explicitly allowed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchWebhookHttpClient(assertPublicUrl, { allowHttpLoopback: true });
    await client.post({
      url: "http://host.docker.internal:3001/api/radioso/commerce",
      rawBody: "{}",
      headers: { "X-Test": "1" },
    });

    expect(assertPublicUrl).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks redirects to private addresses on the next hop", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect("http://127.0.0.1/internal"));
    const assertPublicUrl = vi.fn(async (url: string) => {
      if (url.startsWith("http://127.0.0.1")) {
        throw new Error("private url blocked");
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchWebhookHttpClient(assertPublicUrl, { fetchImpl: fetchThroughGlobal });
    await expect(client.post({
      url: "https://hooks.example.com/start",
      rawBody: "{}",
      headers: {},
    })).rejects.toThrow("Webhook redirect changed origin");

    expect(assertPublicUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without a location header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(redirect(null)));

    const client = new FetchWebhookHttpClient(async () => undefined, { fetchImpl: fetchThroughGlobal });
    await expect(client.post({
      url: "https://hooks.example.com/start",
      rawBody: "{}",
      headers: {},
    })).rejects.toThrow("had no location");
  });

  it("rejects redirects that change origin before forwarding the signed body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect("https://attacker.example.net/capture"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchWebhookHttpClient(async () => undefined, { fetchImpl: fetchThroughGlobal });
    await expect(client.post({
      url: "https://hooks.example.com/start",
      rawBody: JSON.stringify({ sensitive: "payload" }),
      headers: { "X-Radioso-Signature": "sha256=abc" },
    })).rejects.toThrow("changed origin");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces the redirect ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect("/again"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchWebhookHttpClient(async () => undefined, {
      maxRedirects: 1,
      fetchImpl: fetchThroughGlobal,
    });
    await expect(client.post({
      url: "https://hooks.example.com/start",
      rawBody: "{}",
      headers: {},
    })).rejects.toThrow("exceeded 1 redirects");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
