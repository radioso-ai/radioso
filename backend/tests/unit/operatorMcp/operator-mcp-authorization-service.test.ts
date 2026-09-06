import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { OperatorMcpAuthorizationService } from "../../../src/modules/operatorMcpAuthorization/authorizationService.js";
import { hashOpaqueCredential } from "../../../src/modules/operatorMcpAuthorization/domain.js";

const id = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const now = new Date("2026-09-04T00:00:00.000Z");
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

const config = {
  resource: "https://mcp.example/operator/mcp",
  issuer: "https://app.example",
  credentialEpoch: "8",
  authorizationCodeTtlSeconds: 300,
  accessTokenTtlSeconds: 900,
  refreshIdleTtlDays: 30,
  refreshAbsoluteTtlDays: 90,
};

const transaction = {
  id: id("1"), clientRecordId: id("2"), clientId: "https://client.example/cimd", clientVersion: "3",
  clientMetadataSnapshotId: id("3"), clientMetadataDigest: "sha256:metadata", clientDisplayName: "Example Client",
  clientUri: "https://client.example/app",
  applicationType: "web" as const, redirectUri: "https://client.example/callback", state: "state-value",
  codeChallenge: challenge, resource: config.resource, requestedToolScopes: ["operator:read", "operator:probe"] as const,
  requestedOfflineAccess: true, accountId: null, userId: null, sessionId: null, workspaceId: null, membershipId: null,
  approvedToolScopes: null, approvedOfflineAccess: null, status: "pending" as const,
  expiresAt: new Date(now.getTime() + 300_000), createdAt: now, decidedAt: null, consumedAt: null,
};
const attribution = { accountId: id("6"), workspaceId: id("8"), userId: id("7"), clientRecordId: transaction.clientRecordId, grantId: id("4") };

const flowRepository = () => ({
  createTransaction: vi.fn(async () => undefined),
  findTransaction: vi.fn(async () => transaction),
  decideTransaction: vi.fn(async () => true),
  exchangeAuthorizationCode: vi.fn(async () => ({ grantId: id("4"), toolScopes: ["operator:read"] as const, offlineAccess: true, attribution })),
  rotateRefreshCredential: vi.fn<() => Promise<
    | { status: "rotated"; grantId: string; toolScopes: readonly ["operator:read"] }
    | { status: "replay" }
  >>(async () => ({ status: "rotated", grantId: id("4"), toolScopes: ["operator:read"] })),
  revokeCredentialByDigest: vi.fn<() => Promise<typeof attribution | null>>(async () => null),
});

describe("OperatorMcpAuthorizationService", () => {
  it("pins the client snapshot, exact audience, redirect, scopes, state, and PKCE in a short transaction", async () => {
    const repository = flowRepository();
    const service = new OperatorMcpAuthorizationService(repository, config);
    const result = await service.startAuthorization({
      client: {
        recordId: transaction.clientRecordId, clientId: transaction.clientId, clientVersion: transaction.clientVersion,
        metadataSnapshotId: transaction.clientMetadataSnapshotId, metadataDigest: transaction.clientMetadataDigest,
        applicationType: "web", redirectUris: [transaction.redirectUri], displayName: transaction.clientDisplayName,
        clientUri: transaction.clientUri,
      },
      responseType: "code", redirectUri: transaction.redirectUri, state: transaction.state,
      scope: "operator:read operator:probe offline_access", codeChallenge: challenge, codeChallengeMethod: "S256",
      resource: config.resource, now,
    });
    expect(result.consentUrl).toMatch(/^https:\/\/app\.example\/oauth\/operator-mcp\/consent\?transaction=/u);
    expect(repository.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
      clientMetadataSnapshotId: transaction.clientMetadataSnapshotId,
      requestedToolScopes: ["operator:read", "operator:probe"],
      requestedOfflineAccess: true,
      resource: config.resource,
      expiresAt: new Date(now.getTime() + 300_000),
    }));
  });

  it("binds approval to the browser session and narrows scopes/offline access", async () => {
    const repository = flowRepository();
    const audit = { record: vi.fn(async () => undefined) };
    const service = new OperatorMcpAuthorizationService(repository, config, audit);
    const result = await service.decide({
      transactionId: transaction.id, decision: "approve", sessionId: id("5"), accountId: id("6"), userId: id("7"),
      workspaceId: id("8"), membershipId: id("9"), approvedToolScopes: ["operator:read"], approvedOfflineAccess: false, now,
    });
    expect(result.redirectUrl).toContain("code=");
    expect(result.redirectUrl).toContain(`state=${transaction.state}`);
    expect(new URL(result.redirectUrl).searchParams.get("iss")).toBe(config.issuer);
    expect(repository.decideTransaction).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: id("5"), approvedToolScopes: ["operator:read"], approvedOfflineAccess: false, status: "approved",
      authorizationCodeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    expect(audit.record).toHaveBeenCalledWith({
      accountId: id("6"),
      workspaceId: id("8"),
      eventType: "operator_mcp.authorization_decision",
      eventStatus: "success",
      metadata: {
        userId: id("7"),
        clientId: transaction.clientRecordId,
        grantId: null,
        callingSurface: "operator_mcp_consent",
        outcome: "approved",
        reason: "approved",
      },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("operator:read");
  });

  it("includes issuer binding when the operator denies authorization", async () => {
    const repository = flowRepository();
    const service = new OperatorMcpAuthorizationService(repository, config);

    const result = await service.decide({
      transactionId: transaction.id,
      decision: "deny",
      sessionId: id("5"),
      accountId: id("6"),
      userId: id("7"),
      now,
    });

    const redirect = new URL(result.redirectUrl);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(transaction.state);
    expect(redirect.searchParams.get("iss")).toBe(config.issuer);
  });

  it("refuses consent for a workspace outside the deployment rollout", async () => {
    const repository = flowRepository();
    const service = new OperatorMcpAuthorizationService(repository, {
      ...config,
      rolloutWorkspaceIds: new Set([id("99")]),
    });

    await expect(service.decide({
      transactionId: transaction.id,
      decision: "approve",
      sessionId: id("5"),
      accountId: id("6"),
      userId: id("7"),
      workspaceId: id("8"),
      membershipId: id("9"),
      approvedToolScopes: ["operator:read"],
      approvedOfflineAccess: false,
      now,
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.decideTransaction).not.toHaveBeenCalled();
  });

  it("returns terminal transactions for safe consent UX but refuses to decide them again", async () => {
    const repository = flowRepository();
    repository.findTransaction.mockResolvedValueOnce({ ...transaction, status: "expired" });
    const service = new OperatorMcpAuthorizationService(repository, config);
    await expect(service.getTransaction(transaction.id, now)).resolves.toMatchObject({ status: "expired" });

    repository.findTransaction.mockResolvedValueOnce({ ...transaction, status: "approved" });
    await expect(service.decide({
      transactionId: transaction.id, decision: "deny", sessionId: id("5"), accountId: id("6"), userId: id("7"), now,
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.decideTransaction).not.toHaveBeenCalled();
  });

  it("exchanges a bound code using valid S256 and persists exact returned ceilings", async () => {
    const repository = flowRepository();
    const audit = { record: vi.fn(async () => undefined) };
    const metrics = { incrementCounter: vi.fn() };
    const service = new OperatorMcpAuthorizationService(repository, config, audit, metrics);
    const result = await service.exchangeAuthorizationCode({
      code: "authorization-code", clientId: transaction.clientId, redirectUri: transaction.redirectUri,
      codeVerifier: verifier, resource: config.resource, scope: "operator:read", now,
    });
    expect(result).toMatchObject({ tokenType: "Bearer", expiresIn: 900, scope: "operator:read" });
    expect(result.accessToken).toMatch(/^radioso_omcp_at_v1_/u);
    expect(result.refreshToken).toMatch(/^radioso_omcp_rt_v1_/u);
    expect(repository.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      authorizationCodeDigest: hashOpaqueCredential("authorization-code"), clientId: transaction.clientId,
      codeChallenge: challenge, requestedToolScopes: ["operator:read"], credentialEpoch: "8",
      accessCredential: expect.objectContaining({ tokenDigest: hashOpaqueCredential(result.accessToken) }),
      refreshCredential: expect.objectContaining({ tokenDigest: hashOpaqueCredential(result.refreshToken!) }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "operator_mcp.token_exchange", eventStatus: "success", metadata: expect.objectContaining({ grantId: attribution.grantId, reason: "authorization_code" }) }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_oauth_total", expect.objectContaining({ labels: { stage: "token_exchange", outcome: "success", reason: "issued" } }));
  });

  it("fails closed when a refresh generation is replayed", async () => {
    const repository = flowRepository();
    repository.rotateRefreshCredential.mockResolvedValueOnce({ status: "replay", attribution });
    const audit = { record: vi.fn(async () => undefined) };
    const metrics = { incrementCounter: vi.fn() };
    const service = new OperatorMcpAuthorizationService(repository, config, audit, metrics);
    await expect(service.refresh({
      refreshToken: "radioso_omcp_rt_v1_old", clientId: transaction.clientId, resource: config.resource, now,
    })).rejects.toMatchObject({ code: "invalid_grant" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      accountId: attribution.accountId,
      workspaceId: attribution.workspaceId,
      eventType: "operator_mcp.refresh",
      eventStatus: "failure",
      metadata: expect.objectContaining({ reason: "refresh_replay", clientId: attribution.clientRecordId, grantId: attribution.grantId }),
    }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_oauth_total", expect.objectContaining({
      labels: { stage: "refresh", outcome: "failure", reason: "refresh_replay" },
    }));
  });

  it("revokes access or refresh credentials without revealing whether they existed", async () => {
    const repository = flowRepository();
    repository.revokeCredentialByDigest.mockResolvedValueOnce(attribution);
    const audit = { record: vi.fn(async () => undefined) };
    const metrics = { incrementCounter: vi.fn() };
    const service = new OperatorMcpAuthorizationService(repository, config, audit, metrics);
    await expect(service.revoke({ token: "known", clientId: transaction.clientId, now })).resolves.toBeUndefined();
    await expect(service.revoke({ token: "unknown", clientId: transaction.clientId, now })).resolves.toBeUndefined();
    expect(repository.revokeCredentialByDigest).toHaveBeenNthCalledWith(2, {
      tokenDigest: hashOpaqueCredential("unknown"),
      clientId: transaction.clientId,
      now,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "operator_mcp.revocation", metadata: expect.objectContaining({ grantId: attribution.grantId, reason: "oauth_revocation" }) }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("operator_mcp_oauth_total", expect.objectContaining({ labels: { stage: "revocation", outcome: "success", reason: "unknown_token" } }));
  });
});
