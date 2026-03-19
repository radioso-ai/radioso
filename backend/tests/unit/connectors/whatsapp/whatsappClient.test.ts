import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createLogger } from "../../../../src/shared/observability/logger.js";
import {
  WhatsAppClient,
  WhatsAppClientError,
} from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";

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
      new Response(
        JSON.stringify({
          messages: [{ id: "wamid.sent.123" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const client = new WhatsAppClient({
      fetch: fetchMock,
      sleep,
      logger,
    });

    const result = await client.sendTextMessage(
      {
        phoneNumberId: "15550001111",
        accessToken: "wa-access-token",
      },
      {
        to: "14155551234",
        text: "Hello from Hivec",
      },
    );

    expect(result).toEqual({ wamid: "wamid.sent.123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
          to: "14155551234",
          type: "text",
          text: { body: "Hello from Hivec" },
        }),
      }),
    );
  });

  it("retries rate-limited requests with backoff before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited again" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const client = new WhatsAppClient({
      fetch: fetchMock,
      sleep,
      logger,
    });

    const result = await client.sendTextMessage(
      {
        phoneNumberId: "15550001111",
        accessToken: "wa-access-token",
      },
      {
        to: "14155551234",
        text: "Retry please",
      },
    );

    expect(result).toEqual({ wamid: "wamid.ok" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("raises a typed error for persistent auth failures", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new WhatsAppClient({
      fetch: fetchMock,
      sleep,
      logger,
    });

    await expect(
      client.sendTextMessage(
        {
          phoneNumberId: "15550001111",
          accessToken: "wa-access-token",
        },
        {
          to: "14155551234",
          text: "Hello",
        },
      ),
    ).rejects.toMatchObject({
      name: "WhatsAppClientError",
      statusCode: 401,
      retryable: false,
    } satisfies Partial<WhatsAppClientError>);
  });

  it("raises a typed error for bad requests without retrying", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new WhatsAppClient({
      fetch: fetchMock,
      sleep,
      logger,
    });

    await expect(
      client.sendTextMessage(
        {
          phoneNumberId: "15550001111",
          accessToken: "wa-access-token",
        },
        {
          to: "14155551234",
          text: "Hello",
        },
      ),
    ).rejects.toMatchObject({
      name: "WhatsAppClientError",
      statusCode: 400,
      retryable: false,
    } satisfies Partial<WhatsAppClientError>);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
