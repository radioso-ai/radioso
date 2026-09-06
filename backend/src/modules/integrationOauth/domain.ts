import { z } from "zod";

const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

/**
 * A well-formed https URL with no embedded credentials. Network-level SSRF
 * protection still belongs in the consuming service because it requires DNS.
 */
export const oauthHttpsUrlSchema = (maxLength: number, field: string) =>
  trimmedText(maxLength).superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a valid URL` });
      return;
    }
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must use https` });
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must not embed credentials (userinfo)` });
    }
  });

export const oauthConfigInputSchema = z
  .object({
    authorizationEndpoint: oauthHttpsUrlSchema(2048, "authorizationEndpoint"),
    tokenEndpoint: oauthHttpsUrlSchema(2048, "tokenEndpoint"),
    clientId: trimmedText(2048),
    clientSecret: trimmedText(4096).optional(),
    scopes: z.array(trimmedText(512)).max(50).optional(),
  })
  .strict();


export const oauthCompleteInputSchema = z
  .object({
    code: trimmedText(8192),
    state: trimmedText(2048),
  })
  .strict();


export interface StoredOauthClientConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}

export interface StoredOauthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry in epoch milliseconds, when the server returned `expires_in`. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

export interface StoredOauthFlow {
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OauthCredentialRecord {
  id: string;
  credentialCiphertext: string | null;
  oauthClientCiphertext: string | null;
  status?: string;
}

export const oauthConnectionStatuses = ["pending", "authorized", "needs_reauth", "disabled", "error"] as const;
export type OauthConnectionStatus = (typeof oauthConnectionStatuses)[number];

export type OauthReauthStatus = "needs_reauth";

export const oauthConnectionCreateSchema = z
  .object({
    provider: trimmedText(128),
    displayName: trimmedText(160),
    requestedScopes: z.array(trimmedText(512)).max(50).optional(),
  })
  .strict();

export type OauthConnectionCreateInput = z.infer<typeof oauthConnectionCreateSchema>;

export interface OauthConnectionSummary {
  id: string;
  provider: string;
  displayName: string;
  status: OauthConnectionStatus;
  grantedScopes: string[];
  providerAccountId: string | null;
  updatedAt: string;
}

export interface OauthAuthorizationStartResult {
  connectionId: string;
  authorizationUrl: string;
  status: Extract<OauthConnectionStatus, "pending">;
}
