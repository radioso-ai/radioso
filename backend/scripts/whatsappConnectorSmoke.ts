import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import request from "supertest";

import { createTestApp, issueTestToken } from "../tests/support/testApp.js";

const APP_SECRET = "app-secret-smoke";

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

const createTextPayload = (wamid: string, body: string, timestamp: string) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "14155551234", profile: { name: "Alicia" } }],
              messages: [
                {
                  id: wamid,
                  from: "14155551234",
                  timestamp,
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });

const main = async () => {
  let outboundCounter = 0;
  const outboundUrls: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    outboundCounter += 1;
    outboundUrls.push(String(input));
    return new Response(JSON.stringify({ messages: [{ id: `wamid-out-${outboundCounter}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { app, dependencies } = createTestApp({
    whatsappFetch: fetchMock,
    whatsappDebounceMs: 10,
  });
  try {
    const { token, workspaceId } = await issueTestToken(app, "connectors-smoke@example.com");
    const authorization = `Bearer ${token}`;

    const saveResponse = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", authorization)
      .send({ config: validConfig });
    assert.equal(saveResponse.status, 200, "saving WhatsApp config should succeed");

    const enableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set("Authorization", authorization);
    assert.equal(enableResponse.status, 200, "enabling WhatsApp should succeed");

    const firstPayload = createTextPayload("wamid-initial", "hello from whatsapp", "1710752400");
    const firstWebhook = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(firstPayload))
      .send(firstPayload);
    assert.equal(firstWebhook.status, 200, "enabled webhook should acknowledge");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const connectorDb = dependencies.connectorDb as any;
    const conversationId = connectorDb.contacts.get(`${workspaceId}:14155551234`)?.conversationId;
    assert.ok(conversationId, "first inbound message should create a conversation");
    assert.equal(outboundCounter, 1, "enabled webhook should send one WhatsApp reply");

    const firstHistory = await request(app)
      .get(`/api/v1/chat/history/${conversationId}`)
      .set("Authorization", authorization);
    assert.equal(firstHistory.status, 200, "chat history should be readable");
    assert.equal(firstHistory.body.sourceChannel, "whatsapp", "conversation should be tagged with source channel");
    assert.equal(firstHistory.body.messages.length, 2, "first exchange should produce two messages");

    const disableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/disable")
      .set("Authorization", authorization);
    assert.equal(disableResponse.status, 200, "disabling WhatsApp should succeed");

    const disabledPayload = createTextPayload("wamid-disabled", "should not process", "1710752500");
    const disabledWebhook = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(disabledPayload))
      .send(disabledPayload);
    assert.equal(disabledWebhook.status, 200, "disabled webhook should still acknowledge");

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(outboundCounter, 1, "disabled webhook must not send a reply");
    assert.equal(
      connectorDb.messageLogs.get("wamid-disabled"),
      undefined,
      "disabled webhook must not create an inbound message log",
    );

    const updatedConfig = {
      ...validConfig,
      phone_number_id: "15557654321",
      access_token: "access-token-updated-654321",
    };
    const updateResponse = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", authorization)
      .send({ config: updatedConfig });
    assert.equal(updateResponse.status, 200, "updating disabled config should succeed");

    const reenableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set("Authorization", authorization);
    assert.equal(reenableResponse.status, 200, "re-enabling WhatsApp should succeed");

    const secondPayload = createTextPayload("wamid-reenabled", "back again", "1710752600");
    const secondWebhook = await request(app)
      .post(`/api/connectors/whatsapp/${workspaceId}/webhook`)
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", signPayload(secondPayload))
      .send(secondPayload);
    assert.equal(secondWebhook.status, 200, "re-enabled webhook should acknowledge");

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(outboundCounter, 2, "re-enabled webhook should resume replies");
    assert.match(outboundUrls[1] ?? "", /\/15557654321\/messages$/, "updated phone number id should be used after re-enable");

    const preservedHistory = await request(app)
      .get(`/api/v1/chat/history/${conversationId}`)
      .set("Authorization", authorization);
    assert.equal(preservedHistory.status, 200, "history should still be available after disable and re-enable");
    assert.equal(preservedHistory.body.sourceChannel, "whatsapp", "history should preserve source channel");
    assert.equal(preservedHistory.body.messages.length, 4, "history should include both exchanges");

    console.log("WhatsApp connector smoke test passed");
  } finally {
    await dependencies.connectorRegistry.shutdownAll();
  }
};

await main();
