import { createHmac, randomUUID } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWhatsAppWebhookRouter } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappWebhook.js";
import type { WhatsAppMessageHandler } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.js";
import type { WhatsAppPersistencePort } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";

const APP_SECRET = "app-secret-1234";

const signPayload = (payload: string) =>
  `sha256=${createHmac("sha256", APP_SECRET).update(payload).digest("hex")}`;

const createPersistence = () => {
  const logs = new Map<string, Parameters<WhatsAppPersistencePort["createMessageLog"]>[0]>();
  const persistence = {
    logs,
    createMessageLog: vi.fn(async (input: Parameters<WhatsAppPersistencePort["createMessageLog"]>[0]) => {
      logs.set(input.wamid, input);
      return {
        id: randomUUID(),
        ...input,
        errorDetails: input.errorDetails ?? null,
        createdAt: new Date(),
      };
    }),
    createInboundMessageLog: vi.fn(async (input: Parameters<WhatsAppPersistencePort["createInboundMessageLog"]>[0]) => {
      if (logs.has(input.wamid)) {
        return null;
      }
      const record = {
        wamid: input.wamid,
        direction: "inbound" as const,
        workspaceId: input.workspaceId,
        waId: input.waId,
        messageType: input.messageType,
        payload: input.payload,
        status: "received" as const,
      };
      logs.set(input.wamid, record);
      return {
        id: randomUUID(),
        ...record,
        errorDetails: null,
        createdAt: new Date(),
      };
    }),
  };
  return persistence;
};

const setupApp = (overrides?: {
  enabled?: boolean;
  phoneNumberId?: string;
  persistence?: ReturnType<typeof createPersistence>;
  handler?: Pick<WhatsAppMessageHandler, "handleInboundMessage">;
}) => {
  const persistence = overrides?.persistence ?? createPersistence();
  const handler = overrides?.handler ?? {
    handleInboundMessage: vi.fn<WhatsAppMessageHandler["handleInboundMessage"]>(async () => {}),
  };
  const router = createWhatsAppWebhookRouter({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      getConfig: async () => ({
        enabled: overrides?.enabled ?? true,
        config: {
          phone_number_id: overrides?.phoneNumberId ?? "15550001111",
          access_token: "wa-access-token",
          app_secret: APP_SECRET,
          webhook_verify_token: "verify-token-1234",
          business_account_id: "waba-123",
          conversation_timeout_hours: "24",
        },
      }),
    },
    persistence,
    messageHandler: handler,
  });

  const app = express();
  app.use(async (req, _res, next) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    (req as typeof req & { rawBody?: Buffer }).rawBody = rawBody;
    req.body = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
    next();
  });
  app.use("/api/connectors/whatsapp/:workspaceId/webhook", router);

  return { app, persistence, handler };
};

describe("createWhatsAppWebhookRouter", () => {
  it("completes the GET verification handshake for valid tokens", async () => {
    const { app } = setupApp();

    const response = await request(app)
      .get("/api/connectors/whatsapp/workspace-verify/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-token-1234",
        "hub.challenge": "12345",
      });

    expect(response.status).toBe(200);
    expect(response.text).toBe("12345");
  });

  it("rejects invalid verification tokens and invalid signatures", async () => {
    const { app } = setupApp();
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

    const invalidVerify = await request(app)
      .get("/api/connectors/whatsapp/workspace-verify/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "12345",
      });
    const invalidSignature = await request(app)
      .post("/api/connectors/whatsapp/workspace-verify/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", "sha256=bad")
      .send(payload);

    expect(invalidVerify.status).toBe(403);
    expect(invalidSignature.status).toBe(401);
  });

  it("records inbound text logs and dispatches messages asynchronously", async () => {
    const workspaceId = "workspace-text";
    const { app, persistence, handler } = setupApp();
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "15550001111" },
                contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
                messages: [
                  {
                    id: "wamid-inbound-1",
                    from: "14155551234",
                    timestamp: "1710752400",
                    type: "text",
                    text: { body: "Hello there" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const response = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload);

    expect(response.status).toBe(200);
    expect(persistence.logs.get("wamid-inbound-1")).toMatchObject({
      direction: "inbound",
      status: "received",
      workspaceId,
      waId: "14155551234",
    });

    await Promise.resolve();

    expect(handler.handleInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        waId: "14155551234",
        profileName: "Alicia",
        wamid: "wamid-inbound-1",
        phoneNumberId: "15550001111",
        type: "text",
        textBody: "Hello there",
      }),
    );
  });

  it("ignores duplicate wamids and messages for a different configured phone number", async () => {
    const persistence = createPersistence();
    await persistence.createMessageLog({
      wamid: "wamid-duplicate",
      direction: "inbound",
      workspaceId: "workspace-ignore",
      waId: "14155550000",
      messageType: "text",
      payload: { existing: true },
      status: "received",
    });
    const handler = { handleInboundMessage: vi.fn(async () => {}) };
    const { app } = setupApp({ persistence, handler });

    const duplicatePayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { contacts: [{ wa_id: "14155550000" }], messages: [{ id: "wamid-duplicate", from: "14155550000", type: "text", text: { body: "Skip" } }] } }] }],
    });
    const wrongPhonePayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "15559999999" }, contacts: [{ wa_id: "14155550000" }], messages: [{ id: "wamid-wrong", from: "14155550000", type: "text", text: { body: "Skip" } }] } }] }],
    });

    await request(app)
      .post("/api/connectors/whatsapp/workspace-ignore/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(duplicatePayload))
      .send(duplicatePayload)
      .expect(200);
    await request(app)
      .post("/api/connectors/whatsapp/workspace-ignore/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(wrongPhonePayload))
      .send(wrongPhonePayload)
      .expect(200);

    await Promise.resolve();

    expect(handler.handleInboundMessage).not.toHaveBeenCalled();
    expect(persistence.logs.get("wamid-wrong")).toBeUndefined();
  });

  it("acks concurrent duplicate deliveries when the idempotent insert reports a conflict", async () => {
    const persistence = createPersistence();
    persistence.createInboundMessageLog.mockResolvedValueOnce(null);
    const handler = { handleInboundMessage: vi.fn(async () => {}) };
    const { app } = setupApp({ persistence, handler });
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { contacts: [{ wa_id: "14155550000" }], messages: [{ id: "wamid-race", from: "14155550000", type: "text", text: { body: "Skip" } }] } }] }],
    });

    await request(app)
      .post("/api/connectors/whatsapp/workspace-ignore/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload)
      .expect(200);

    await Promise.resolve();

    expect(handler.handleInboundMessage).not.toHaveBeenCalled();
  });
});
