import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../../support/testApp.js";

const validConfig = {
  phone_number_id: "15551234567",
  access_token: "access-token-123456",
  app_secret: "app-secret-abcdef",
  webhook_verify_token: "verify-token-xyz987",
  business_account_id: "987654321",
  conversation_timeout_hours: "24",
};

describe("connector management contract", () => {
  it("lists whatsapp and returns detail with masked secrets", async () => {
    const { app } = createTestApp();
    const { token, workspaceId } = await issueTestToken(app, "connectors-list@example.com");
    const authorization = `Bearer ${token}`;

    const listResponse = await request(app)
      .get("/api/v1/connectors")
      .set("Authorization", authorization);

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.connectors).toEqual([
      {
        id: "whatsapp",
        name: "WhatsApp",
        description: "Connect a workspace to WhatsApp Business so incoming messages flow through chat.",
        enabled: false,
        errorStatus: null,
      },
    ]);

    const saveResponse = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", authorization)
      .send({ config: validConfig });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.schema).toHaveLength(6);
    expect(saveResponse.body.enabled).toBe(false);
    expect(saveResponse.body.webhookUrl).toContain(`/api/connectors/whatsapp/${workspaceId}/webhook`);
    expect(saveResponse.body.config).toMatchObject({
      phone_number_id: "15551234567",
      business_account_id: "987654321",
      conversation_timeout_hours: "24",
    });
    expect(saveResponse.body.config.access_token).toMatch(/3456$/);
    expect(saveResponse.body.config.access_token).not.toBe(validConfig.access_token);
    expect(saveResponse.body.config.app_secret).toMatch(/cdef$/);

    const detailResponse = await request(app)
      .get("/api/v1/connectors/whatsapp")
      .set("Authorization", authorization);

    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body).toMatchObject({
      ...saveResponse.body,
      webhookUrl: expect.stringContaining(`/api/connectors/whatsapp/${workspaceId}/webhook`),
    });
  });

  it("validates required fields on enable and preserves config across disable", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "connectors-enable@example.com");
    const authorization = `Bearer ${token}`;

    const partialSave = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", authorization)
      .send({
        config: {
          phone_number_id: validConfig.phone_number_id,
        },
      });

    expect(partialSave.status).toBe(200);

    const enableWithoutRequiredFields = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set("Authorization", authorization);

    expect(enableWithoutRequiredFields.status).toBe(400);
    expect(enableWithoutRequiredFields.body).toEqual({
      error: "Validation failed",
      fields: expect.arrayContaining([
        { key: "access_token", message: "Access Token is required" },
        { key: "app_secret", message: "App Secret is required" },
        { key: "webhook_verify_token", message: "Webhook Verify Token is required" },
        { key: "business_account_id", message: "Business Account ID is required" },
      ]),
    });

    const fullSave = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", authorization)
      .send({ config: validConfig });

    expect(fullSave.status).toBe(200);

    const enableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set("Authorization", authorization);

    expect(enableResponse.status).toBe(200);
    expect(enableResponse.body.enabled).toBe(true);
    expect(enableResponse.body.config.phone_number_id).toBe(validConfig.phone_number_id);

    const disableResponse = await request(app)
      .post("/api/v1/connectors/whatsapp/disable")
      .set("Authorization", authorization);

    expect(disableResponse.status).toBe(200);
    expect(disableResponse.body.enabled).toBe(false);
    expect(disableResponse.body.config.phone_number_id).toBe(validConfig.phone_number_id);
  });

  it("rejects duplicate phone numbers across workspaces", async () => {
    const { app } = createTestApp();
    const first = await issueTestToken(app, "connectors-duplicate-a@example.com");
    const second = await issueTestToken(app, "connectors-duplicate-b@example.com");

    await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", `Bearer ${first.token}`)
      .send({ config: validConfig });

    const firstEnable = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set("Authorization", `Bearer ${first.token}`);

    expect(firstEnable.status).toBe(200);

    const secondSave = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set("Authorization", `Bearer ${second.token}`)
      .send({
        config: {
          ...validConfig,
          access_token: "different-token-123456",
        },
      });

    expect(secondSave.status).toBe(409);
    expect(secondSave.body).toEqual({
      error: "Channel identity conflict",
      detail: "Phone Number ID is already configured in another workspace.",
    });
  });
});
