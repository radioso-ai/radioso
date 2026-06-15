import { describe, expect, it } from "vitest";

import { CustomerEmailDeliveryService } from "../../../src/modules/customerEmail/services/customerEmailDeliveryService.js";
import { CustomerEmailProviderRejectedError, type CustomerEmailProviderAdapter } from "../../../src/modules/customerEmail/providers/customerEmailProvider.js";
import { StaticCustomerEmailProviderRegistry } from "../../../src/modules/customerEmail/public.js";
import type { CustomerEmailConnectionRecord } from "../../../src/db/repositories/customerEmailConnectionRepository.js";
import { encryptOauthClientConfig, encryptOauthTokens } from "../../../src/modules/integrationOauth/public.js";

const key = Buffer.from("e".repeat(32)).toString("base64");

const connection = (status: CustomerEmailConnectionRecord["status"] = "authorized"): CustomerEmailConnectionRecord => ({
  id: "connection-1",
  workspaceId: "workspace-1",
  oauthConnectionId: "oauth-1",
  provider: "google_mail",
  displayName: "Support outbound",
  senderEmail: "support@example.com",
  senderName: "Support",
  replyToEmail: "reply@example.com",
  status,
  lastHealthStatus: null,
  lastHealthCheckedAt: null,
  lastErrorCode: null,
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
});

const message = {
  to: "customer@example.com",
  subject: "Follow-up",
  bodyText: "Hello",
};

const buildService = (provider: CustomerEmailProviderAdapter, record = connection()) => {
  const updates: unknown[] = [];
  const service = new CustomerEmailDeliveryService({
    connections: {
      create: async () => record,
      findById: async () => record,
      listByWorkspace: async () => [record],
      update: async (_workspaceId, _id, input) => {
        updates.push(input);
        return { ...record, ...input };
      },
      countSkillReferences: async () => 0,
      remove: async () => true,
    },
    oauthCredentials: {
      findCredentialById: async () => ({
        id: "oauth-1",
        status: "authorized",
        credentialCiphertext: encryptOauthTokens({ accessToken: "secret-token" }, key),
        oauthClientCiphertext: encryptOauthClientConfig({
          authorizationEndpoint: "https://provider.example/auth",
          tokenEndpoint: "https://provider.example/token",
          clientId: "client-id",
        }, key),
      }),
    },
    oauthTokenRepository: {
      setOauthTokens: async () => null,
      updateStatus: async () => null,
    },
    providers: new StaticCustomerEmailProviderRegistry([provider]),
    encryptionKey: key,
    timeoutMs: 5,
  });
  return { service, updates };
};

describe("CustomerEmailDeliveryService", () => {
  it("creates drafts and sends messages through the provider without exposing provider input in outcomes", async () => {
    const provider: CustomerEmailProviderAdapter = {
      provider: "google_mail",
      checkHealth: async () => ({ status: "ok" }),
      createDraft: async (input) => {
        expect(input.accessToken).toBe("secret-token");
        expect(input.bodyText).toBe("Hello");
        return { providerMessageId: "draft-1" };
      },
      sendMessage: async () => ({ providerMessageId: "sent-1" }),
    };
    const { service } = buildService(provider);

    await expect(service.deliver({ workspaceId: "workspace-1", connectionId: "connection-1", mode: "draft", message }))
      .resolves.toEqual({ outcome: "drafted", providerMessageId: "draft-1" });
    await expect(service.deliver({ workspaceId: "workspace-1", connectionId: "connection-1", mode: "send", message }))
      .resolves.toEqual({ outcome: "sent", providerMessageId: "sent-1" });
  });

  it("maps disabled and needs-reauth connections to typed outcomes before provider calls", async () => {
    const provider: CustomerEmailProviderAdapter = {
      provider: "google_mail",
      checkHealth: async () => ({ status: "ok" }),
      sendMessage: async () => {
        throw new Error("should not be called");
      },
    };

    await expect(buildService(provider, connection("disabled")).service.deliver({
      workspaceId: "workspace-1",
      connectionId: "connection-1",
      mode: "send",
      message,
    })).resolves.toMatchObject({ outcome: "disabled_connection" });
    await expect(buildService(provider, connection("needs_reauth")).service.deliver({
      workspaceId: "workspace-1",
      connectionId: "connection-1",
      mode: "send",
      message,
    })).resolves.toMatchObject({ outcome: "needs_reauth" });
  });

  it("maps provider rejections, provider errors, and timeouts to sanitized typed outcomes", async () => {
    const rejecting: CustomerEmailProviderAdapter = {
      provider: "google_mail",
      checkHealth: async () => ({ status: "ok" }),
      sendMessage: async () => {
        throw new CustomerEmailProviderRejectedError("quota exceeded for sensitive body");
      },
    };
    await expect(buildService(rejecting).service.deliver({ workspaceId: "workspace-1", connectionId: "connection-1", mode: "send", message }))
      .resolves.toEqual({ outcome: "provider_rejected", errorCode: "provider_rejected" });

    const failing: CustomerEmailProviderAdapter = {
      provider: "google_mail",
      checkHealth: async () => ({ status: "ok" }),
      sendMessage: async () => {
        throw new Error("raw provider body");
      },
    };
    await expect(buildService(failing).service.deliver({ workspaceId: "workspace-1", connectionId: "connection-1", mode: "send", message }))
      .resolves.toEqual({ outcome: "failed", errorCode: "provider_failed" });

    const slow: CustomerEmailProviderAdapter = {
      provider: "google_mail",
      checkHealth: async () => ({ status: "ok" }),
      sendMessage: async () => new Promise((resolve) => setTimeout(() => resolve({}), 50)),
    };
    await expect(buildService(slow).service.deliver({ workspaceId: "workspace-1", connectionId: "connection-1", mode: "send", message }))
      .resolves.toEqual({ outcome: "failed", errorCode: "provider_timeout" });
  });
});
