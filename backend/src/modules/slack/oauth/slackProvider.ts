import { OauthClientError, type NormalizedOauthTokenResponse, type OauthProviderDefinition } from "../../integrationOauth/public.js";
import { slackBotScopes } from "../manifest/slackManifest.js";

export const SLACK_OAUTH_PROVIDER_ID = "slack";

export interface SlackOauthProviderCredentialConfig {
  clientId?: string;
  clientSecret?: string;
}

export interface SlackOauthMetadata {
  teamId: string;
  teamName: string | null;
  botUserId: string;
  authedUserId: string | null;
}

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const normalizeSlackScope = (scope: string | undefined): string | undefined =>
  scope?.split(/[,\s]+/u).filter(Boolean).join(" ");

export const normalizeSlackOauthTokenResponse = (payload: unknown): NormalizedOauthTokenResponse & {
  metadata: SlackOauthMetadata;
} => {
  const body = readObject(payload);
  if (body.ok !== true) {
    const error = readString(body.error) ?? "unknown_error";
    throw new OauthClientError("invalid_token_response", `Slack OAuth token response was not ok: ${error}`);
  }

  const accessToken = readString(body.access_token);
  const botUserId = readString(body.bot_user_id);
  const team = readObject(body.team);
  const teamId = readString(team.id);
  const authedUser = readObject(body.authed_user);
  if (!accessToken || !botUserId || !teamId) {
    throw new OauthClientError("invalid_token_response", "Slack OAuth token response was missing required bot or team fields");
  }

  const teamName = readString(team.name) ?? null;
  const authedUserId = readString(authedUser.id) ?? null;
  return {
    tokens: {
      accessToken,
      ...(readString(body.token_type) ? { tokenType: readString(body.token_type) } : {}),
      ...(normalizeSlackScope(readString(body.scope)) ? { scope: normalizeSlackScope(readString(body.scope)) } : {}),
    },
    providerAccountId: teamId,
    metadata: {
      teamId,
      teamName,
      botUserId,
      authedUserId,
    },
  };
};

export const buildSlackOauthProviderDefinition = (
  config: SlackOauthProviderCredentialConfig,
): OauthProviderDefinition | null => {
  if (!config.clientId || !config.clientSecret) {
    return null;
  }
  const scopes = [...slackBotScopes];
  return {
    id: SLACK_OAUTH_PROVIDER_ID,
    authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    defaultScopes: scopes,
    allowedScopes: scopes,
    tokenResponseNormalizer: normalizeSlackOauthTokenResponse,
  };
};
