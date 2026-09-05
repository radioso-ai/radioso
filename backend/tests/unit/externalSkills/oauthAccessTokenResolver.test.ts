import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpConnectionRecord } from "../../../src/db/repositories/mcpConnectionRepository.js";
import { __setOauthClock, type FetchLike } from "../../../src/modules/externalSkills/oauth/oauthClient.js";
import {
  encryptOauthClientConfig,
  encryptOauthTokens,
  decryptOauthTokens,
} from "../../../src/modules/externalSkills/oauth/oauthCrypto.js";
import {
  OauthNotAuthorizedError,
  resolveFreshAccessToken,
  type OauthTokenPersistencePort,
} from "../../../src/modules/externalSkills/oauth/oauthAccessTokenResolver.js";
import type { StoredOauthClientConfig, StoredOauthTokens } from "../../../src/modules/externalSkills/domain.js";

// 32-byte base64 key for AES-256-GCM.
const KEY = Buffer.alloc(32, 7).toString("base64");

const CONFIG: StoredOauthClientConfig = {
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  clientId: "client-123",
  clientSecret: "shh",
};

const buildRecord = (tokens: StoredOauthTokens | null): McpConnectionRecord => ({
  id: "conn-1",
  agentId: "agent-1",
  displayName: "Scheduler",
  serverUrl: "https://mcp.example.com",
  authMethod: "oauth",
  credentialCiphertext: tokens ? encryptOauthTokens(tokens, KEY) : null,
  encryptionKeyId: null,
  oauthClientCiphertext: encryptOauthClientConfig(CONFIG, KEY),
  oauthFlowCiphertext: null,
  status: "authorized",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const buildRepo = () => {
  const calls: { setOauthTokens: string[]; needsReauth: number } = { setOauthTokens: [], needsReauth: 0 };
  const repository: OauthTokenPersistencePort = {
    setOauthTokens: async (_agentId, _id, ciphertext) => {
      calls.setOauthTokens.push(ciphertext);
      return null;
    },
    updateStatus: async (_agentId, _id, status) => {
      if (status === "needs_reauth") calls.needsReauth += 1;
      return null;
    },
  };
  return { repository, calls };
};

afterEach(() => {
  __setOauthClock(() => Date.now());
});

describe("resolveFreshAccessToken", () => {
  it("returns the stored token when it is still valid (no refresh)", async () => {
    __setOauthClock(() => 1_000_000);
    const { repository, calls } = buildRepo();
    const fetchImpl = vi.fn<FetchLike>();

    const token = await resolveFreshAccessToken({
      agentId: "agent-1",
      record: buildRecord({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000_000 + 600_000 }),
      repository,
      encryptionKey: KEY,
      fetchImpl,
    });

    expect(token).toBe("at-1");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.setOauthTokens).toHaveLength(0);
  });

  it("refreshes an expired token, persists it, and returns the new token", async () => {
    __setOauthClock(() => 2_000_000);
    const { repository, calls } = buildRepo();
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-2", expires_in: 3600 }),
      });

    const token = await resolveFreshAccessToken({
      agentId: "agent-1",
      record: buildRecord({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 2_000_000 - 1 }),
      repository,
      encryptionKey: KEY,
      fetchImpl,
    });

    expect(token).toBe("at-2");
    expect(calls.setOauthTokens).toHaveLength(1);
    // Persisted ciphertext decrypts back to the refreshed token (and keeps the refresh token).
    expect(decryptOauthTokens(calls.setOauthTokens[0], KEY)).toMatchObject({
      accessToken: "at-2",
      refreshToken: "rt-1",
    });
    expect(calls.needsReauth).toBe(0);
  });

  it("re-checks the token endpoint public-URL guard before refreshing", async () => {
    __setOauthClock(() => 2_000_000);
    const { repository } = buildRepo();
    const assertPublicUrl = vi.fn();
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-2", expires_in: 3600 }),
      });

    await resolveFreshAccessToken({
      agentId: "agent-1",
      record: buildRecord({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 2_000_000 - 1 }),
      repository,
      encryptionKey: KEY,
      assertPublicUrl,
      fetchImpl,
    });

    expect(assertPublicUrl).toHaveBeenCalledWith(CONFIG.tokenEndpoint);
  });

  it("flags needs_reauth and throws when refresh fails", async () => {
    __setOauthClock(() => 3_000_000);
    const { repository, calls } = buildRepo();
    const fetchImpl: FetchLike = () =>
      Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });

    await expect(
      resolveFreshAccessToken({
        agentId: "agent-1",
        record: buildRecord({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: 3_000_000 - 1 }),
        repository,
        encryptionKey: KEY,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OauthNotAuthorizedError);

    expect(calls.needsReauth).toBe(1);
  });

  it("flags needs_reauth and throws when no credential is stored", async () => {
    const { repository, calls } = buildRepo();
    await expect(
      resolveFreshAccessToken({
        agentId: "agent-1",
        record: buildRecord(null),
        repository,
        encryptionKey: KEY,
      }),
    ).rejects.toBeInstanceOf(OauthNotAuthorizedError);
    expect(calls.needsReauth).toBe(1);
  });
});
