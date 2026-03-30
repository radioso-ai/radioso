import { createHmac } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

const APP_SECRET = "app-secret-abcdef";

const validConfig = {
  phone_number_id: "15551234567",
  access_token: "access-token-123456",
  app_secret: APP_SECRET,
  webhook_verify_token: "verify-token-xyz987",
  business_account_id: "987654321",
  conversation_timeout_hours: "24",
};

const signPayload = (payload: string) =>
  `sha256=${createHmac("sha256", APP_SECRET).update(payload).digest("hex")}`;

describe("connector lifecycle contract", () => {
  it("acknowledges disabled webhooks, supports re-enable with updated config, and preserves history", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      const callNumber = fetchMock.mock.calls.length + 1;
      return new Response(JSON.stringify({ messages: [{ id: `wamid-out-${callNumber}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { app, dependencies } = createTestApp({
      whatsappFetch: fetchMock,
      whatsappDebounceMs: 10,
    });
    const session = await issueTestSession(app, "connectors-lifecycle@example.com");
    const { workspaceId } = session;

    await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set(adminSessionHeaders(session))
      .send({ config: validConfig });

    await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set(adminSessionHeaders(session));

    const initialPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
                messages: [
                  {
                    id: "wamid-initial",
                    from: "14155551234",
                    timestamp: "1710752400",
                    type: "text",
                    text: { body: "hello from whatsapp" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const initialWebhook = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(initialPayload))
      .send(initialPayload);

    expect(initialWebhook.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 40));

    const connectorDb = dependencies.connectorDb as any;
    const conversationId = connectorDb.contacts.get(`${workspaceId}:14155551234`)?.conversationId;
    expect(conversationId).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const initialHistory = await request(app)
      .get(`/api/v1/chat/history/${conversationId}`)
      .set(adminSessionHeaders(session));

    expect(initialHistory.status).toBe(200);
    expect(initialHistory.body.sourceChannel).toBe("whatsapp");
    expect(initialHistory.body.messages).toHaveLength(2);

    const disableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/disable")
      .set(adminSessionHeaders(session));

    expect(disableResponse.status).toBe(200);
    expect(disableResponse.body.enabled).toBe(false);

    const disabledPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
                messages: [
                  {
                    id: "wamid-disabled",
                    from: "14155551234",
                    timestamp: "1710752500",
                    type: "text",
                    text: { body: "should not be processed" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const disabledWebhook = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(disabledPayload))
      .send(disabledPayload);

    expect(disabledWebhook.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(connectorDb.messageLogs.get("wamid-disabled")).toBeUndefined();

    const updatedConfig = {
      ...validConfig,
      phone_number_id: "15557654321",
      access_token: "access-token-updated-654321",
    };

    const saveUpdatedConfig = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set(adminSessionHeaders(session))
      .send({ config: updatedConfig });

    expect(saveUpdatedConfig.status).toBe(200);
    expect(saveUpdatedConfig.body.config.phone_number_id).toBe("15557654321");

    const reenableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set(adminSessionHeaders(session));

    expect(reenableResponse.status).toBe(200);
    expect(reenableResponse.body.enabled).toBe(true);

    const reenabledPayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
                messages: [
                  {
                    id: "wamid-reenabled",
                    from: "14155551234",
                    timestamp: "1710752600",
                    type: "text",
                    text: { body: "back again" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const reenabledWebhook = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(reenabledPayload))
      .send(reenabledPayload);

    expect(reenabledWebhook.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/15557654321/messages");

    const preservedHistory = await request(app)
      .get(`/api/v1/chat/history/${conversationId}`)
      .set(adminSessionHeaders(session));

    expect(preservedHistory.status).toBe(200);
    expect(preservedHistory.body.sourceChannel).toBe("whatsapp");
    expect(preservedHistory.body.messages).toHaveLength(4);
    expect(preservedHistory.body.messages[0].content).toBe("hello from whatsapp");
  });
});
