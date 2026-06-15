import { createHash, randomBytes } from "node:crypto";

import type { StoredOauthClientConfig, StoredOauthTokens } from "../domain.js";

const base64Url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export const createPkcePair = (): PkcePair => {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
};

export const createOauthState = (): string => base64Url(randomBytes(24));

export type OauthClientErrorCode =
  | "token_exchange_failed"
  | "refresh_failed"
  | "invalid_token_response";

export class OauthClientError extends Error {
  constructor(
    readonly code: OauthClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OauthClientError";
  }
}

export interface BuildAuthorizationUrlInput {
  config: Pick<StoredOauthClientConfig, "authorizationEndpoint" | "clientId" | "scopes">;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export const buildAuthorizationUrl = (input: BuildAuthorizationUrlInput): string => {
  const url = new URL(input.config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.config.scopes && input.config.scopes.length > 0) {
    url.searchParams.set("scope", input.config.scopes.join(" "));
  }
  return url.toString();
};

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface TokenEndpointResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const applyClientAuth = (
  config: StoredOauthClientConfig,
  headers: Record<string, string>,
  params: URLSearchParams,
): void => {
  if (config.clientSecret) {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else {
    params.set("client_id", config.clientId);
  }
};

const parseTokenResponse = (payload: TokenEndpointResponse, fallback?: StoredOauthTokens): StoredOauthTokens => {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
  if (!accessToken) {
    throw new OauthClientError("invalid_token_response", "Token response did not include an access token");
  }
  const refreshToken =
    typeof payload.refresh_token === "string" ? payload.refresh_token : fallback?.refreshToken;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn ? { expiresAt: nowMs() + expiresIn * 1000 } : {}),
    ...(typeof payload.token_type === "string" ? { tokenType: payload.token_type } : {}),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
};

let nowMs = (): number => Date.now();
export const __setOauthClock = (clock: () => number): void => {
  nowMs = clock;
};

const postForm = async (
  fetchImpl: FetchLike,
  tokenEndpoint: string,
  params: URLSearchParams,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<TokenEndpointResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      return Promise.reject(response.status);
    }
    return (await response.json()) as TokenEndpointResponse;
  } finally {
    clearTimeout(timer);
  }
};

export interface ExchangeCodeInput {
  config: StoredOauthClientConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

export const exchangeAuthorizationCode = async (input: ExchangeCodeInput): Promise<StoredOauthTokens> => {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const headers: Record<string, string> = {};
  applyClientAuth(input.config, headers, params);
  try {
    const payload = await postForm(
      input.fetchImpl,
      input.config.tokenEndpoint,
      params,
      headers,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseTokenResponse(payload);
  } catch (error) {
    if (error instanceof OauthClientError) {
      throw error;
    }
    throw new OauthClientError("token_exchange_failed", "Authorization code exchange failed");
  }
};

export interface RefreshTokensInput {
  config: StoredOauthClientConfig;
  tokens: StoredOauthTokens;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

export const refreshAccessToken = async (input: RefreshTokensInput): Promise<StoredOauthTokens> => {
  if (!input.tokens.refreshToken) {
    throw new OauthClientError("refresh_failed", "No refresh token is available");
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.tokens.refreshToken,
  });
  if (input.config.scopes && input.config.scopes.length > 0) {
    params.set("scope", input.config.scopes.join(" "));
  }
  const headers: Record<string, string> = {};
  applyClientAuth(input.config, headers, params);
  try {
    const payload = await postForm(
      input.fetchImpl,
      input.config.tokenEndpoint,
      params,
      headers,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseTokenResponse(payload, input.tokens);
  } catch (error) {
    if (error instanceof OauthClientError) {
      throw error;
    }
    throw new OauthClientError("refresh_failed", "Token refresh failed");
  }
};

export const isAccessTokenExpired = (tokens: StoredOauthTokens, skewMs = 60_000): boolean => {
  if (!tokens.accessToken) {
    return true;
  }
  if (tokens.expiresAt === undefined) {
    return false;
  }
  return nowMs() >= tokens.expiresAt - skewMs;
};
