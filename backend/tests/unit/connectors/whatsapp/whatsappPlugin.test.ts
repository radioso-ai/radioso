import { createHmac } from "node:crypto";

import express, { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhatsAppPlugin } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappPlugin.js";
import { ConnectorRegistry } from "../../../../src/modules/connectors/services/connectorRegistry.js";
import { InMemoryConnectorDatabase } from "../../../support/fakes.js";

const ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const APP_SECRET = "app-secret-1234";

const signPayload = (payload: string) =>
  `sha256=${createHmac("sha256", APP_SECRET).update(payload).digest("hex")}`;

const createLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  }) as any;

const createRegistry = async (
  db: InMemoryConnectorDatabase,
  plugin: WhatsAppPlugin,
  workspaceId: string,
) => {
  const registry = new ConnectorRegistry();
  registry.register(plugin);
  registry.setEncryptionKey(ENCRYPTION_KEY);

  await registry.saveConfig(db as any, workspaceId, "whatsapp", {
    phone_number_id: "15550001111",
    access_token: "wa-access-token",
    app_secret: APP_SECRET,
    webhook_verify_token: "verify-token-1234",
    business_account_id: "waba-123",
    conversation_timeout_hours: "24",
  });
  await registry.enableConnector(db as any, workspaceId, "whatsapp");

  return registry;
};

describe("WhatsAppPlugin", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("declares the expected config schema and webhook path", () => {
    const plugin = new WhatsAppPlugin();

    expect(plugin.id).toBe("whatsapp");
    expect(plugin.name).toBe("WhatsApp");
    expect(plugin.configSchema()).toEqual([
      expect.objectContaining({ key: "phone_number_id", type: "text", required: true }),
      expect.objectContaining({ key: "access_token", type: "secret", required: true }),
      expect.objectContaining({ key: "app_secret", type: "secret", required: true }),
      expect.objectContaining({ key: "webhook_verify_token", type: "secret", required: true }),
      expect.objectContaining({ key: "business_account_id", type: "text", required: true }),
      expect.objectContaining({
        key: "conversation_timeout_hours",
        type: "text",
        required: false,
        defaultValue: "24",
      }),
    ]);
    expect(plugin.getWebhookPath()).toBe("/api/connectors/whatsapp/:workspaceId/webhook");
    expect(plugin.uniqueChannelField()).toBe("phone_number_id");
  });

  it("validates required fields and conversation timeout semantics", () => {
    const plugin = new WhatsAppPlugin();

    expect(plugin.validateConfig({})).toEqual([]);
    expect(
      plugin.validateConfig({
        conversation_timeout_hours: "0",
      }),
    ).toEqual([
      {
        key: "conversation_timeout_hours",
        message: "Conversation timeout must be a positive integer number of hours",
      },
    ]);
    expect(
      plugin.validateConfig({
        conversation_timeout_hours: "6.5",
      }),
    ).toEqual([
      {
        key: "conversation_timeout_hours",
        message: "Conversation timeout must be a positive integer number of hours",
      },
    ]);
    expect(
      plugin.validateConfig({
        phone_number_id: "1234567890",
        access_token: "token",
        app_secret: "app-secret",
        webhook_verify_token: "verify-token",
        business_account_id: "waba-123",
        conversation_timeout_hours: "48",
      }),
    ).toEqual([]);
  });

  it("updates error status on 401 delivery failure and clears it after save plus re-enable", async () => {
    const workspaceId = "workspace-error-status";
    const db = new InMemoryConnectorDatabase();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid WhatsApp access token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const plugin = new WhatsAppPlugin({
      fetch: fetchMock,
      debounceMs: 10,
      cleanupIntervalMs: 60_000,
    });
    const registry = await createRegistry(db, plugin, workspaceId);
    const logger = createLogger();
    const chatService = {
      answer: vi.fn(async () => ({
        conversationId: "conversation-1",
        answer: "Hello back",
        retrievalInfo: {
          candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
          fallbackApplied: true,
          rerankStatus: "skipped",
        },
      })),
    } as any;
    const router = Router();

    await plugin.initialize({
      db: db as any,
      logger,
      chatService,
      connectorRegistry: registry,
      router,
    });

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use("/", router);

    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
                messages: [
                  {
                    id: "wamid-error-status",
                    from: "14155551234",
                    timestamp: "1710752400",
                    type: "text",
                    text: { body: "hello" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const response = await request(app)
      .post(`/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload);

    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(db.configs.get(`${workspaceId}:whatsapp`)?.errorStatus).toBe("Invalid WhatsApp access token");

    const saveResult = await registry.saveConfig(db as any, workspaceId, "whatsapp", {
      access_token: "wa-access-token-updated",
    });
    expect(saveResult.kind).toBe("success");
    expect(db.configs.get(`${workspaceId}:whatsapp`)?.errorStatus).toBeNull();

    const enableResult = await registry.enableConnector(db as any, workspaceId, "whatsapp");
    expect(enableResult.kind).toBe("success");
    expect(db.configs.get(`${workspaceId}:whatsapp`)?.errorStatus).toBeNull();

    await plugin.shutdown();
  });

  it("removes whatsapp message logs older than 90 days on startup and interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00.000Z"));

    const db = new InMemoryConnectorDatabase();
    db.insertMessageLog({
      wamid: "wamid-old-startup",
      workspaceId: "workspace-cleanup",
      waId: "14155550000",
      messageType: "text",
      payload: { body: "old" },
      status: "replied",
      createdAt: new Date("2025-12-01T10:00:00.000Z"),
    });
    db.insertMessageLog({
      wamid: "wamid-new",
      workspaceId: "workspace-cleanup",
      waId: "14155550000",
      messageType: "text",
      payload: { body: "new" },
      status: "replied",
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
    });

    const plugin = new WhatsAppPlugin({
      cleanupIntervalMs: 1_000,
    });
    const logger = createLogger();

    await plugin.initialize({
      db: db as any,
      logger,
      chatService: { answer: vi.fn() } as any,
      connectorRegistry: {
        getDecryptedConfig: vi.fn(async () => null),
        setErrorStatus: vi.fn(async () => {}),
      } as any,
      router: Router(),
    });

    expect(db.messageLogs.has("wamid-old-startup")).toBe(false);
    expect(db.messageLogs.has("wamid-new")).toBe(true);

    db.insertMessageLog({
      wamid: "wamid-old-interval",
      workspaceId: "workspace-cleanup",
      waId: "14155550000",
      messageType: "text",
      payload: { body: "old again" },
      status: "replied",
      createdAt: new Date("2025-12-02T10:00:00.000Z"),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(db.messageLogs.has("wamid-old-interval")).toBe(false);
    expect(db.messageLogs.has("wamid-new")).toBe(true);

    await plugin.shutdown();
  });
});
