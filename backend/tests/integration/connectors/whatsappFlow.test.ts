import { createHmac } from "node:crypto";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";
import { createLogger } from "../../../src/shared/observability/logger.js";
import { createTestApp, issueTestToken } from "../../support/testApp.js";

const APP_SECRET = "app-secret-1234";

const signPayload = (payload: string) =>
  `sha256=${createHmac("sha256", APP_SECRET).update(payload).digest("hex")}`;

describe("WhatsApp integration flow", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("acknowledges a webhook, runs chat, and records inbound/outbound logs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00.000Z"));

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid-outbound-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { app, dependencies } = createTestApp();
    const { token, workspaceId } = await issueTestToken(app, "whatsapp-flow@example.com");

    await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        config: {
          phone_number_id: "15550001111",
          access_token: "wa-access-token",
          app_secret: APP_SECRET,
          webhook_verify_token: "verify-token-1234",
          business_account_id: "waba-123",
          conversation_timeout_hours: "24",
        },
      });

    await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set("Authorization", `Bearer ${token}`);

    await dependencies.connectorRegistry.initializeAll({
      db: dependencies.connectorDb,
      logger: createLogger("silent"),
      chat: createConnectorChatPort(dependencies.chatService),
    });

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
                    text: { body: "What can you help with?" },
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
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(payload))
      .send(payload);

    expect(response.status).toBe(200);

    await vi.advanceTimersByTimeAsync(3000);

    const connectorDb = dependencies.connectorDb as any;
    expect(connectorDb.messageLogs.get("wamid-inbound-1")).toMatchObject({
      status: "replied",
      workspaceId,
      waId: "14155551234",
    });
    expect(connectorDb.messageLogs.get("wamid-outbound-1")).toMatchObject({
      direction: "outbound",
      status: "replied",
    });
    expect(connectorDb.contacts.get(`${workspaceId}:14155551234`)).toBeDefined();

    const conversationId = connectorDb.contacts.get(`${workspaceId}:14155551234`).conversationId;
    const history = await request(app)
      .get(`/api/v1/chat/history/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(history.status).toBe(200);
    expect(history.body.sourceChannel).toBe("whatsapp");
    expect(history.body.messages).toHaveLength(2);
    expect(history.body.messages[0]).toMatchObject({
      role: "user",
      content: "What can you help with?",
    });
    expect(history.body.messages[1]).toMatchObject({
      role: "assistant",
      content: "I could not find relevant information in your documents.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
