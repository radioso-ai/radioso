import { describe, expect, it, vi } from "vitest";

import {
  encryptOauthClientConfig,
  encryptOauthTokens,
  OauthNotAuthorizedError,
  resolveFreshAccessToken,
  type FetchLike,
  type OauthCredentialRecord,
  type OauthTokenPersistencePort,
} from "../../../src/modules/integrationOauth/public.js";

const encryptionKey = Buffer.from("d".repeat(32)).toString("base64");

const record = (tokens: { accessToken: string; refreshToken?: string; expiresAt?: number }): OauthCredentialRecord => ({
  id: "oauth-1",
  credentialCiphertext: encryptOauthTokens(tokens, encryptionKey),
  oauthClientCiphertext: encryptOauthClientConfig({
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client-1",
  }, encryptionKey),
});

const disabledRecord = (
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number },
): OauthCredentialRecord => ({
  ...record(tokens),
  status: "disabled",
});

describe("integration OAuth access token resolver", () => {
  it("returns a stored access token that is still fresh", async () => {
    const repository: OauthTokenPersistencePort = {
      setOauthTokens: vi.fn(),
      updateStatus: vi.fn(),
    };

    await expect(resolveFreshAccessToken({
      subjectId: "workspace-1",
      record: record({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 600_000 }),
      repository,
      encryptionKey,
    })).resolves.toBe("access-1");

    expect(repository.setOauthTokens).not.toHaveBeenCalled();
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the encrypted replacement", async () => {
    const repository: OauthTokenPersistencePort = {
      setOauthTokens: vi.fn(async () => null),
      updateStatus: vi.fn(),
    };
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
    });

    await expect(resolveFreshAccessToken({
      subjectId: "workspace-1",
      record: record({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 }),
      repository,
      encryptionKey,
      fetchImpl,
    })).resolves.toBe("access-2");

    expect(repository.setOauthTokens).toHaveBeenCalledWith(
      "workspace-1",
      "oauth-1",
      expect.any(String),
      null,
    );
  });

  it("does not refresh a disabled credential", async () => {
    const repository: OauthTokenPersistencePort = {
      setOauthTokens: vi.fn(),
      updateStatus: vi.fn(),
    };
    const fetchImpl = vi.fn<FetchLike>();

    await expect(resolveFreshAccessToken({
      subjectId: "workspace-1",
      record: disabledRecord({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 }),
      repository,
      encryptionKey,
      fetchImpl,
    })).rejects.toBeInstanceOf(OauthNotAuthorizedError);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(repository.setOauthTokens).not.toHaveBeenCalled();
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it("marks the credential as needing reauthorization when refresh fails permanently", async () => {
    const repository: OauthTokenPersistencePort = {
      setOauthTokens: vi.fn(),
      updateStatus: vi.fn(async () => null),
    };
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_grant" }),
    });

    await expect(resolveFreshAccessToken({
      subjectId: "workspace-1",
      record: record({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 }),
      repository,
      encryptionKey,
      fetchImpl,
    })).rejects.toBeInstanceOf(OauthNotAuthorizedError);

    expect(repository.updateStatus).toHaveBeenCalledWith("workspace-1", "oauth-1", "needs_reauth");
  });

  it("keeps the connection authorized when refresh fails transiently", async () => {
    const repository: OauthTokenPersistencePort = {
      setOauthTokens: vi.fn(),
      updateStatus: vi.fn(async () => null),
    };
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const error = await resolveFreshAccessToken({
      subjectId: "workspace-1",
      record: record({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 }),
      repository,
      encryptionKey,
      fetchImpl,
    }).catch((caught) => caught);

    // A momentary 5xx must not force a manual re-authorization.
    expect(error).not.toBeInstanceOf(OauthNotAuthorizedError);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it("single-flights concurrent refreshes for the same connection", async () => {
    const repository: OauthTokenPersistencePort = {
      setOauthTokens: vi.fn(async () => null),
      updateStatus: vi.fn(),
    };
    let refreshCalls = 0;
    const fetchImpl: FetchLike = async () => {
      refreshCalls += 1;
      // Yield so both callers are in flight before either resolves.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, status: 200, json: async () => ({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }) };
    };

    const expired = () => record({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() - 1 });
    const resolve = () =>
      resolveFreshAccessToken({ subjectId: "workspace-1", record: expired(), repository, encryptionKey, fetchImpl });

    const [a, b] = await Promise.all([resolve(), resolve()]);

    expect(a).toBe("access-2");
    expect(b).toBe("access-2");
    // The rotating refresh token is spent exactly once even under concurrency.
    expect(refreshCalls).toBe(1);
    expect(repository.setOauthTokens).toHaveBeenCalledTimes(1);
  });
});
