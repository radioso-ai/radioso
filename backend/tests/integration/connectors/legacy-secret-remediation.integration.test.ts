import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

const legacyConfig = {
  phone_number_id: "15551234567",
  access_token: "access-token-123456",
  app_secret: "app-secret-abcdef",
  webhook_verify_token: "verify-token-xyz987",
  business_account_id: "987654321",
  conversation_timeout_hours: "24",
};

describe("legacy connector secret remediation integration", () => {
  it("surfaces remediation-required secret state until the operator re-enters secret fields", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "legacy-remediation@example.com");
    const connectorDb = dependencies.connectorDb as any;

    connectorDb.configs.set(`${session.workspaceId}:whatsapp`, {
      id: "legacy-config",
      workspaceId: session.workspaceId,
      connectorId: "whatsapp",
      enabled: false,
      configData: legacyConfig,
      errorStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const detailBefore = await request(app)
      .get("/api/v1/connectors/whatsapp")
      .set(adminSessionHeaders(session));

    expect(detailBefore.status).toBe(200);
    expect(detailBefore.body.errorStatus).toBe("secret_rotation_required");
    expect(detailBefore.body.config.access_token).toBe("[re-enter secret]");

    const blockedEnable = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set(adminSessionHeaders(session));

    expect(blockedEnable.status).toBe(400);

    const remediatedSave = await request(app)
      .put("/api/v1/connectors/whatsapp")
      .set(adminSessionHeaders(session))
      .send({
        config: {
          ...legacyConfig,
          access_token: "new-access-token-654321",
          app_secret: "new-app-secret-fedcba",
          webhook_verify_token: "new-verify-token-123456",
        },
      });

    expect(remediatedSave.status).toBe(200);
    expect(remediatedSave.body.errorStatus).toBeNull();

    const enableAfter = await request(app)
      .post("/api/v1/connectors/whatsapp/enable")
      .set(adminSessionHeaders(session));

    expect(enableAfter.status).toBe(200);
    expect(enableAfter.body.enabled).toBe(true);
  });
});
