import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { WhatsAppClient, WhatsAppClientError } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { createLogger } from "../../../../src/shared/observability/logger.js";

const MEDIA_URL = "https://lookaside.example/whatsapp_business/attachments/?mid=media-1&token=signed-secret";
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const CONFIG = { accessToken: "wa-access-token" };
const INPUT = { mediaId: "media-1", wamid: "wamid-in-1" };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const metadata = (overrides: Record<string, unknown> = {}): Response =>
  json({ url: MEDIA_URL, mime_type: "image/jpeg", file_size: PHOTO.length, sha256: "abc", id: "media-1", ...overrides });

const bytesResponse = (body: Uint8Array, headers: Record<string, string> = {}): Response =>
  new Response(new Blob([Uint8Array.from(body)]), { status: 200, headers: { "content-type": "image/jpeg", ...headers } });

/** A body that yields chunks of `chunkSize` bytes until it has sent `total`, and notes if it was cut off. */
const streamedBody = (total: number, chunkSize: number) => {
  let sent = 0;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { status: 200 }), state };
};

const capturedLogger = () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger("debug", stream), raw: () => chunks.join("") };
};

const outcomes = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }): string[] =>
  metrics.incrementCounter.mock.calls.map(([, options]) => (options as { labels: { outcome: string } }).labels.outcome);

const clientFor = (fetchImpl: typeof fetch, options: { mediaFetch?: typeof fetch; mediaMaxBytes?: number; mediaTimeoutMs?: number; logger?: ReturnType<typeof createLogger> } = {}) => {
  const metrics = { incrementCounter: vi.fn() };
  const client = new WhatsAppClient({
    fetch: fetchImpl,
    mediaFetch: options.mediaFetch,
    mediaMaxBytes: options.mediaMaxBytes,
    mediaTimeoutMs: options.mediaTimeoutMs,
    metrics,
    logger: options.logger ?? createLogger("silent"),
  });
  return { client, metrics };
};

describe("WhatsAppClient.downloadImage", () => {
  it("resolves the media id through Graph, then downloads the bytes with the connector's token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(bytesResponse(PHOTO));
    const { client, metrics } = clientFor(fetchMock, { mediaFetch });

    const result = await client.downloadImage(CONFIG, INPUT);

    expect(result).toEqual({ kind: "downloaded", bytes: PHOTO });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://graph.facebook.com/v21.0/media-1");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer wa-access-token" } });
    expect(mediaFetch.mock.calls[0]?.[0]).toBe(MEDIA_URL);
    expect(mediaFetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer wa-access-token" }, redirect: "manual" });
    expect(outcomes(metrics)).toEqual(["downloaded"]);
  });

  it("downloads the bytes through the same fetch when no media transport is given", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(bytesResponse(PHOTO));
    const { client } = clientFor(fetchMock);

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toMatchObject({ kind: "downloaded" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a photo Graph says is over the cap, without downloading it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata({ file_size: 5_000 }));
    const mediaFetch = vi.fn<typeof fetch>();
    const { client, metrics } = clientFor(fetchMock, { mediaFetch, mediaMaxBytes: 1_000 });

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "too_large" });
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(outcomes(metrics)).toEqual(["too_large"]);
  });

  it("refuses a download whose content-length is over the cap", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata({ file_size: undefined }));
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(bytesResponse(PHOTO, { "content-length": "5000" }));
    const { client } = clientFor(fetchMock, { mediaFetch, mediaMaxBytes: 1_000 });

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "too_large" });
  });

  it("stops reading a body that outgrows the cap, whatever it declared", async () => {
    const { response, state } = streamedBody(10_000, 400);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata({ file_size: 100 }));
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
    const { client, metrics } = clientFor(fetchMock, { mediaFetch, mediaMaxBytes: 1_000 });

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "too_large" });
    expect(state.cancelled).toBe(true);
    expect(outcomes(metrics)).toEqual(["too_large"]);
  });

  it.each([400, 404, 410])("treats Graph's %s for the media id as a photo that is gone", async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { message: "Object does not exist" } }, status));
    const { client, metrics } = clientFor(fetchMock);

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "not_found" });
    expect(outcomes(metrics)).toEqual(["not_found"]);
  });

  it.each([429, 500, 503])("raises a retryable error when Graph answers %s", async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { message: "try later" } }, status));
    const { client, metrics } = clientFor(fetchMock);

    await expect(client.downloadImage(CONFIG, INPUT)).rejects.toMatchObject({
      name: "WhatsAppClientError",
      statusCode: status,
      retryable: true,
    } satisfies Partial<WhatsAppClientError>);
    expect(outcomes(metrics)).toEqual(["failed"]);
  });

  it("raises a non-retryable error when Graph rejects the token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ error: { message: "invalid token" } }, 401));
    const { client } = clientFor(fetchMock);

    await expect(client.downloadImage(CONFIG, INPUT)).rejects.toMatchObject({ statusCode: 401, retryable: false });
  });

  it("raises a retryable error when the media host answers 5xx", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status: 502 }));
    const { client } = clientFor(fetchMock, { mediaFetch });

    await expect(client.downloadImage(CONFIG, INPUT)).rejects.toMatchObject({ statusCode: 502, retryable: true });
  });

  it("treats a media host that no longer has the photo as gone", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 404 }));
    const { client } = clientFor(fetchMock, { mediaFetch });

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "not_found" });
  });

  it("raises a retryable error when the download exceeds its timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const { client, metrics } = clientFor(fetchMock, { mediaFetch, mediaTimeoutMs: 20 });

    await expect(client.downloadImage(CONFIG, INPUT)).rejects.toMatchObject({
      name: "WhatsAppClientError",
      retryable: true,
      message: "WhatsApp media download timed out",
    });
    expect(outcomes(metrics)).toEqual(["failed"]);
  });

  it("gives the Graph call the timeout too", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const { client } = clientFor(fetchMock, { mediaTimeoutMs: 20 });

    await expect(client.downloadImage(CONFIG, INPUT)).rejects.toMatchObject({ retryable: true, message: "WhatsApp media download timed out" });
  });

  it("never carries a transport error's text into the error it raises", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${MEDIA_URL}`));
    const { client } = clientFor(fetchMock, { mediaFetch });

    const error = await client.downloadImage(CONFIG, INPUT).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "WhatsAppClientError", retryable: true });
    expect((error as Error).message).not.toContain("lookaside");
    expect((error as Error).message).not.toContain("signed-secret");
  });

  it.each([
    ["a plain http URL", "http://lookaside.example/photo"],
    ["a URL carrying credentials", "https://user:pass@lookaside.example/photo"],
    ["something that is not a URL", "not a url"],
  ])("refuses to follow %s from Graph", async (_label, url) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata({ url }));
    const mediaFetch = vi.fn<typeof fetch>();
    const { client, metrics } = clientFor(fetchMock, { mediaFetch });

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "invalid_response" });
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(outcomes(metrics)).toEqual(["invalid_response"]);
  });

  it("treats an empty download as an invalid response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(bytesResponse(new Uint8Array(0)));
    const { client } = clientFor(fetchMock, { mediaFetch });

    await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "invalid_response" });
  });

  describe("redirects", () => {
    it("follows a redirect to another https host without the connector's token", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
      const mediaFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.example/photo.jpg" } }))
        .mockResolvedValueOnce(bytesResponse(PHOTO));
      const { client } = clientFor(fetchMock, { mediaFetch });

      await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "downloaded", bytes: PHOTO });
      expect(mediaFetch.mock.calls[1]?.[0]).toBe("https://cdn.example/photo.jpg");
      expect(mediaFetch.mock.calls[1]?.[1]?.headers).toEqual({});
      expect(mediaFetch.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual" });
    });

    it("keeps the token on a redirect that stays on the media host", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
      const mediaFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/whatsapp_business/attachments/other" } }))
        .mockResolvedValueOnce(bytesResponse(PHOTO));
      const { client } = clientFor(fetchMock, { mediaFetch });

      await client.downloadImage(CONFIG, INPUT);

      expect(mediaFetch.mock.calls[1]?.[0]).toBe("https://lookaside.example/whatsapp_business/attachments/other");
      expect(mediaFetch.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer wa-access-token" });
    });

    it("refuses a redirect to plain http", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
      const mediaFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://cdn.example/photo.jpg" } }));
      const { client } = clientFor(fetchMock, { mediaFetch });

      await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "invalid_response" });
      expect(mediaFetch).toHaveBeenCalledTimes(1);
    });

    it("gives up on a chain of redirects", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
      const mediaFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://cdn.example/again" } }));
      const { client } = clientFor(fetchMock, { mediaFetch });

      await expect(client.downloadImage(CONFIG, INPUT)).resolves.toEqual({ kind: "unavailable", reason: "invalid_response" });
      expect(mediaFetch.mock.calls.length).toBeLessThanOrEqual(4);
    });
  });

  it("logs the outcome by message id only, never the media URL, the token or the bytes", async () => {
    const { logger, raw } = capturedLogger();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata());
    const mediaFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(bytesResponse(PHOTO));
    const { client } = clientFor(fetchMock, { mediaFetch, logger });

    await client.downloadImage(CONFIG, INPUT);

    const logged = raw();
    expect(logged).toContain("wamid-in-1");
    expect(logged).not.toContain("lookaside");
    expect(logged).not.toContain("signed-secret");
    expect(logged).not.toContain("wa-access-token");
  });
});
