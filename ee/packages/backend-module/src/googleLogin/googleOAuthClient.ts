// Self-contained Google OAuth client for user sign-in. All Google-specific
// knowledge (endpoints, request shapes, userinfo fields) lives here in EE; the
// OSS host only receives a provider-agnostic verified-identity assertion.

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

type FetchLike = typeof fetch;

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPES = ["openid", "email", "profile"];

export type GoogleOAuthErrorCode =
  | "token_exchange_failed"
  | "userinfo_failed"
  | "invalid_userinfo";

export class GoogleOAuthError extends Error {
  constructor(message: string, readonly code: GoogleOAuthErrorCode) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export const buildGoogleAuthorizationUrl = (input: {
  config: GoogleOAuthConfig;
  state: string;
  /**
   * Address to preselect in the account chooser. Invitations are addressed to
   * one mailbox, so hinting it keeps someone from signing in with an unrelated
   * Google account and provisioning a stray organization instead of joining.
   */
  loginHint?: string;
}): string => {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (input.loginHint) {
    url.searchParams.set("login_hint", input.loginHint);
  }
  return url.toString();
};

const exchangeAuthorizationCode = async (input: {
  config: GoogleOAuthConfig;
  code: string;
  fetchImpl: FetchLike;
}): Promise<string> => {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await input.fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new GoogleOAuthError(
      `Google token exchange failed with status ${response.status}`,
      "token_exchange_failed",
    );
  }

  const json = (await response.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new GoogleOAuthError("Google token response missing access_token", "token_exchange_failed");
  }

  return json.access_token;
};

const fetchUserInfo = async (input: {
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<GoogleIdentity> => {
  const response = await input.fetchImpl(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });

  if (!response.ok) {
    throw new GoogleOAuthError(
      `Google userinfo request failed with status ${response.status}`,
      "userinfo_failed",
    );
  }

  const json = (await response.json()) as {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
  };

  if (typeof json.sub !== "string" || typeof json.email !== "string") {
    throw new GoogleOAuthError("Google userinfo missing sub or email", "invalid_userinfo");
  }

  // Google returns email_verified as a boolean or the string "true".
  const emailVerified = json.email_verified === true || json.email_verified === "true";

  return {
    subject: json.sub,
    email: json.email,
    emailVerified,
  };
};

/**
 * Completes the authorization-code exchange and resolves the verified identity.
 */
export const resolveGoogleIdentity = async (input: {
  config: GoogleOAuthConfig;
  code: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleIdentity> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const accessToken = await exchangeAuthorizationCode({
    config: input.config,
    code: input.code,
    fetchImpl,
  });
  return fetchUserInfo({ accessToken, fetchImpl });
};
