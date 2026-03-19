import { createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ConnectorRegistry } from "../../../../src/modules/connectors/services/connectorRegistry.js";
import { WhatsAppPlugin } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappPlugin.js";
import { PostgresWhatsAppPersistence } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappPersistence.js";
import { createWhatsAppWebhookRouter } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappWebhook.js";
import { InMemoryConnectorDatabase } from "../../../support/fakes.js";

const APP_SECRET = "app-secret-1234";

const signPayload = (payload: string) =>
  `sha256=${createHmac("sha256", APP_SECRET).update(payload).digest("hex")}`;

describe("createWhatsAppWebhookRouter", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  } as any;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const createRegistry = async (db: InMemoryConnectorDatabase, workspaceId: string, enabled = true) => {
    const registry = new ConnectorRegistry();
    registry.register(new WhatsAppPlugin());
    registry.setEncryptionKey(Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));
    await registry.saveConfig(db as any, workspaceId, "whatsapp", {
      phone_number_id: "15550001111",
      access_token: "wa-access-token",
      app_secret: APP_SECRET,
      webhook_verify_token: "verify-token-1234",
      business_account_id: "waba-123",
      conversation_timeout_hours: "24",
    });
    if (enabled) {
      await registry.enableConnector(db as any, workspaceId, "whatsapp");
    }
    return registry;
  };

  const createApp = async (workspaceId: string) => {
    const db = new InMemoryConnectorDatabase();
    const registry = await createRegistry(db, workspaceId);
    const handler = {
      handleInboundMessage: vi.fn(async () => {}),
    };
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use(
      "/",
      createWhatsAppWebhookRouter({
        logger,
        state: {
          getConfig: async (currentWorkspaceId: string) =>
            registry.getDecryptedConfig(db as any, currentWorkspaceId, "whatsapp"),
        },
        persistence: new PostgresWhatsAppPersistence(db as any),
        messageHandler: handler,
      }),
    );
    return { app, db, handler };
  };

  it("completes the GET verification handshake for valid tokens", async () => {
    const { app } = await createApp("workspace-verify");

    const response = await request(app)
      .get("/workspace-verify/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-token-1234",
        "hub.challenge": "12345",
      });

    expect(response.status).toBe(200);
    expect(response.text).toBe("12345");
  });

  it("rejects invalid verification tokens", async () => {
    const { app } = await createApp("workspace-verify");

    const response = await request(app)
      .get("/workspace-verify/webhook")
      .query({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "12345",
      });

    expect(response.status).toBe(403);
  });

  it("rejects POST requests with missing or invalid signatures", async () => {
    const { app } = await createApp("workspace-post");
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });

    const missing = await request(app)
      .post("/workspace-post/webhook")
      .set("Content-Type", "application/json")
      .send(payload);

    const invalid = await request(app)
      .post("/workspace-post/webhook")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", "sha256=bad")
      .send(payload);

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("acknowledges text messages, records inbound logs, and dispatches asynchronously", async () => {
    const workspaceId = "workspace-text";
    const { app, db, handler } = await createApp(workspaceId);
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
      .post(`/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload);

    expect(response.status).toBe(200);
    expect(db.messageLogs.get("wamid-inbound-1")).toMatchObject({
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
        type: "text",
        textBody: "Hello there",
      }),
    );
  });

  it("ignores status-only updates and duplicate wamids", async () => {
    const workspaceId = "workspace-ignore";
    const { app, db, handler } = await createApp(workspaceId);
    await db.insertInboundMessageLog({
      wamid: "wamid-duplicate",
      workspaceId,
      waId: "14155550000",
      messageType: "text",
      payload: { existing: true },
    });

    const statusPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: "wamid-status-1", status: "delivered" }],
              },
            },
          ],
        },
      ],
    });

    const duplicatePayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "14155550000", profile: { name: "Dup" } }],
                messages: [
                  {
                    id: "wamid-duplicate",
                    from: "14155550000",
                    timestamp: "1710752400",
                    type: "text",
                    text: { body: "Should skip" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const statusResponse = await request(app)
      .post(`/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(statusPayload))
      .send(statusPayload);

    const duplicateResponse = await request(app)
      .post(`/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(duplicatePayload))
      .send(duplicatePayload);

    expect(statusResponse.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);

    await Promise.resolve();

    expect(handler.handleInboundMessage).not.toHaveBeenCalled();
  });
});
