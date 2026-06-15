import { describe, expect, it, vi } from "vitest";

import { CustomerEmailOAuthService } from "../../../src/modules/customerEmail/services/customerEmailOAuthService.js";
import type {
  OauthAuthorizationStartResult,
  OauthConnectionSummary,
} from "../../../src/modules/integrationOauth/public.js";

const createSharedOauth = () => ({
  create: vi.fn<(
    workspaceId: string,
    input: { provider: string; displayName: string; requestedScopes?: string[] },
  ) => Promise<OauthAuthorizationStartResult>>(),
  get: vi.fn<(workspaceId: string, connectionId: string) => Promise<OauthConnectionSummary>>(),
  reauthorize: vi.fn<(workspaceId: string, connectionId: string) => Promise<OauthAuthorizationStartResult>>(),
});

describe("CustomerEmailOAuthService", () => {
  it("starts OAuth only for customer email providers", async () => {
    const sharedOauth = createSharedOauth();
    sharedOauth.create.mockResolvedValue({
      connectionId: "connection-1",
      authorizationUrl: "https://oauth.example.com/authorize",
      status: "pending",
    });
    const service = new CustomerEmailOAuthService(sharedOauth);

    await expect(
      service.start("workspace-1", {
        provider: "google_mail",
        displayName: "Support Gmail",
        requestedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      }),
    ).resolves.toEqual({
      connectionId: "connection-1",
      authorizationUrl: "https://oauth.example.com/authorize",
      status: "pending",
    });
    expect(sharedOauth.create).toHaveBeenCalledWith("workspace-1", {
      provider: "google_mail",
      displayName: "Support Gmail",
      requestedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    });

    await expect(
      service.start("workspace-1", {
        provider: "test_mail",
        displayName: "Not a built-in mail provider",
      }),
    ).rejects.toThrow("Unsupported customer email OAuth provider");
  });

  it("returns status only for customer email OAuth connections", async () => {
    const sharedOauth = createSharedOauth();
    sharedOauth.get.mockResolvedValueOnce({
      id: "connection-1",
      provider: "microsoft_graph_mail",
      displayName: "Outlook",
      status: "authorized",
      grantedScopes: ["Mail.Send"],
      providerAccountId: null,
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    sharedOauth.get.mockResolvedValueOnce({
      id: "connection-2",
      provider: "mcp",
      displayName: "MCP",
      status: "authorized",
      grantedScopes: [],
      providerAccountId: null,
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    const service = new CustomerEmailOAuthService(sharedOauth);

    await expect(service.getStatus("workspace-1", "connection-1")).resolves.toMatchObject({
      provider: "microsoft_graph_mail",
    });
    await expect(service.getStatus("workspace-1", "connection-2")).rejects.toThrow(
      "OAuth connection is not a customer email provider",
    );
  });

  it("delegates reauthorization after status verifies a mail provider", async () => {
    const sharedOauth = createSharedOauth();
    sharedOauth.get.mockResolvedValue({
      id: "connection-1",
      provider: "google_mail",
      displayName: "Gmail",
      status: "needs_reauth",
      grantedScopes: [],
      providerAccountId: null,
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    sharedOauth.reauthorize.mockResolvedValue({
      connectionId: "connection-1",
      authorizationUrl: "https://oauth.example.com/authorize",
      status: "pending",
    });
    const service = new CustomerEmailOAuthService(sharedOauth);

    await expect(service.reauthorize("workspace-1", "connection-1")).resolves.toMatchObject({
      connectionId: "connection-1",
      status: "pending",
    });
    expect(sharedOauth.reauthorize).toHaveBeenCalledWith("workspace-1", "connection-1");
  });
});
