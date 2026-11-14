import { createHmac, randomUUID } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWhatsAppWebhookRouter, findInboundMessageInPayload } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappWebhook.js";
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
  handler?: Pick<WhatsAppMessageHandler, "handleInboundMessage"> & Partial<Pick<WhatsAppMessageHandler, "handleFailedStatus">>;
}) => {
  const persistence = overrides?.persistence ?? createPersistence();
  const handler = {
    handleFailedStatus: vi.fn<WhatsAppMessageHandler["handleFailedStatus"]>(async () => {}),
    ...(overrides?.handler ?? { handleInboundMessage: vi.fn<WhatsAppMessageHandler["handleInboundMessage"]>(async () => {}) }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const router = createWhatsAppWebhookRouter({
    logger,
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

  return { app, persistence, handler, logger };
};

// The visitor's WhatsApp id is their phone number.
const visitorPhone = "14155550000";

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
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
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

  const imagePayload = (image: Record<string, unknown> | undefined, id = "wamid-photo-1") => ({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: "15550001111" },
          contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
          messages: [{ id, from: "14155551234", timestamp: "1710752400", type: "image", ...(image ? { image } : {}) }],
        },
      }],
    }],
  });

  it.each([
    ["with a caption", { id: "media-1", mime_type: "image/jpeg", sha256: "abc", caption: "Something like this" }, "Something like this"],
    ["without a caption", { id: "media-1", mime_type: "image/jpeg", sha256: "abc" }, undefined],
    ["with a blank caption", { id: "media-1", mime_type: "image/jpeg", caption: "   " }, undefined],
  ])("hands an image message %s to the handler as a photo and its typed text", async (_label, image, textBody) => {
    const { app, handler } = setupApp();
    const payload = JSON.stringify(imagePayload(image));

    await request(app)
      .post("/api/connectors/whatsapp/workspace-photo/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload)
      .expect(200);
    await Promise.resolve();

    expect(handler.handleInboundMessage).toHaveBeenCalledTimes(1);
    const [message] = (handler.handleInboundMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
    expect(message).toMatchObject({ wamid: "wamid-photo-1", type: "image", image: { mediaId: "media-1" } });
    expect(message.textBody).toBe(textBody);
  });

  it("leaves an image message without a media id as a plain image message", async () => {
    const { app, handler } = setupApp();
    const payload = JSON.stringify(imagePayload(undefined));

    await request(app)
      .post("/api/connectors/whatsapp/workspace-photo/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload)
      .expect(200);
    await Promise.resolve();

    const [message] = (handler.handleInboundMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
    expect(message).toMatchObject({ type: "image" });
    expect(message.image).toBeUndefined();
  });

  it("recovers an image message, caption included, from its stored payload", () => {
    const recovered = findInboundMessageInPayload(
      "workspace-photo",
      imagePayload({ id: "media-9", mime_type: "image/png", caption: "This one" }, "wamid-photo-9"),
      "wamid-photo-9",
    );

    expect(recovered).toMatchObject({ type: "image", image: { mediaId: "media-9" }, textBody: "This one" });
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
    const { app, logger } = setupApp({ persistence, handler });
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
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ wamid: "wamid-race" }), "WhatsApp duplicate webhook skipped");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(visitorPhone);
  });

  it("names a failed inbound message by its message id, never the visitor's phone number", async () => {
    const handler = { handleInboundMessage: vi.fn(async () => { throw new Error("handler failed"); }) };
    const { app, logger } = setupApp({ handler });
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { contacts: [{ wa_id: visitorPhone }], messages: [{ id: "wamid-failed", from: visitorPhone, type: "text", text: { body: "Hello" } }] } }] }],
    });

    await request(app)
      .post("/api/connectors/whatsapp/workspace-failed/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload)
      .expect(200);

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ wamid: "wamid-failed", err: expect.any(Error) }),
      "WhatsApp inbound message processing failed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(visitorPhone);
  });

  it("hands each failed delivery status of this number to the handler, and no other status", async () => {
    const { app, handler } = setupApp();
    const status = (id: string, state: string, errors?: unknown[]) => ({ id, status: state, recipient_id: visitorPhone, timestamp: "1773828000", ...(errors ? { errors } : {}) });
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [
        { value: { metadata: { phone_number_id: "15550001111" }, statuses: [
          status("wamid.sent.1", "failed", [{ code: 131053, title: "Media upload error" }]),
          status("wamid.sent.2", "delivered"),
        ] } },
        { value: { metadata: { phone_number_id: "15559999999" }, statuses: [status("wamid.other.1", "failed")] } },
      ] }],
    });

    await request(app)
      .post("/api/connectors/whatsapp/workspace-status/webhook")
      .set("content-type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload)
      .expect(200);
    await Promise.resolve();

    expect(handler.handleFailedStatus).toHaveBeenCalledTimes(1);
    expect(handler.handleFailedStatus).toHaveBeenCalledWith({ workspaceId: "workspace-status", wamid: "wamid.sent.1", errorCode: 131053 });
    expect(handler.handleInboundMessage).not.toHaveBeenCalled();
  });
});
