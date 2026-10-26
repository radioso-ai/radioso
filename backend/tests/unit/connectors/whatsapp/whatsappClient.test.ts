import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhatsAppClient, WhatsAppClientError } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { createLogger } from "../../../../src/shared/observability/logger.js";

const visitorPhoneNumber = "14155551234";

const createCapturedLogger = (): { logger: ReturnType<typeof createLogger>; lines: () => Record<string, unknown>[] } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: createLogger("debug", stream),
    lines: () => chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

describe("WhatsAppClient", () => {
  const logger = createLogger("silent");
  const sleep = vi.fn(async () => {});
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a text message using the Graph API contract", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.sent.123" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new WhatsAppClient({ fetch: fetchMock, sleep, logger });
    const result = await client.sendTextMessage(
      { phoneNumberId: "15550001111", accessToken: "wa-access-token" },
      { to: visitorPhoneNumber, text: "Hello from Radioso", outboundWamid: "local-wamid-1" },
    );

    expect(result).toEqual({ wamid: "wamid.sent.123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v21.0/15550001111/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer wa-access-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: visitorPhoneNumber,
          type: "text",
          text: { body: "Hello from Radioso" },
        }),
      }),
    );
  });

  it("never logs the visitor's phone number or the provider's response text", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: `blocked: ${visitorPhoneNumber}` } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.sent.456" }] }), { status: 200 }));

    const { logger: capturedLogger, lines } = createCapturedLogger();
    const client = new WhatsAppClient({ fetch: fetchMock, sleep, logger: capturedLogger });

    await client.sendTextMessage(
      { phoneNumberId: "15550001111", accessToken: "wa-access-token" },
      { to: visitorPhoneNumber, text: "Hello from Radioso", outboundWamid: "local-wamid-2" },
    );

    const raw = lines();
    for (const line of raw) {
      expect(JSON.stringify(line)).not.toContain(visitorPhoneNumber);
    }
    const rateLimited = raw.find((line) => line.msg === "WhatsApp rate limited");
    const sent = raw.find((line) => line.msg === "WhatsApp reply sent");
    expect(rateLimited).toMatchObject({ outboundWamid: "local-wamid-2", statusCode: 429 });
    expect(rateLimited).not.toHaveProperty("to");
    expect(sent).toMatchObject({ outboundWamid: "local-wamid-2", wamid: "wamid.sent.456" });
    expect(sent).not.toHaveProperty("to");
  });

  it("logs a send failure by internal id and status only, never the phone number or provider text", async () => {
    const providerText = `Rejected for ${visitorPhoneNumber}: payload malformed`;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: providerText } }), { status: 401 }));

    const { logger: capturedLogger, lines } = createCapturedLogger();
    const client = new WhatsAppClient({ fetch: fetchMock, sleep, logger: capturedLogger });

    await expect(
      client.sendTextMessage(
        { phoneNumberId: "15550001111", accessToken: "wa-access-token" },
        { to: visitorPhoneNumber, text: "Hello", outboundWamid: "local-wamid-3" },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    const raw = lines();
    for (const line of raw) {
      expect(JSON.stringify(line)).not.toContain(visitorPhoneNumber);
      expect(JSON.stringify(line)).not.toContain("payload malformed");
    }
    const failed = raw.find((line) => line.msg === "WhatsApp send failed");
    expect(failed).toMatchObject({ outboundWamid: "local-wamid-3", statusCode: 401 });
    expect(failed).not.toHaveProperty("to");
    expect(failed).not.toHaveProperty("err");
  });

  it("retries rate-limited requests with backoff before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited again" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 }));

    const client = new WhatsAppClient({ fetch: fetchMock, sleep, logger });

    await expect(
      client.sendTextMessage(
        { phoneNumberId: "15550001111", accessToken: "wa-access-token" },
        { to: visitorPhoneNumber, text: "Retry please", outboundWamid: "local-wamid-retry" },
      ),
    ).resolves.toEqual({ wamid: "wamid.ok" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("raises a typed error for non-retryable provider failures", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 }),
    );

    const client = new WhatsAppClient({ fetch: fetchMock, sleep, logger });

    await expect(
      client.sendTextMessage(
        { phoneNumberId: "15550001111", accessToken: "wa-access-token" },
        { to: visitorPhoneNumber, text: "Hello", outboundWamid: "local-wamid-reject" },
      ),
    ).rejects.toMatchObject({
      name: "WhatsAppClientError",
      statusCode: 401,
      retryable: false,
    } satisfies Partial<WhatsAppClientError>);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
