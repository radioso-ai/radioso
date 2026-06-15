import { badRequest } from "../../shared/domain/errors.js";
import type { OauthProviderDefinition } from "../integrationOauth/public.js";

export const customerEmailOauthProviderIds = ["google_mail", "microsoft_graph_mail"] as const;
export type CustomerEmailOauthProviderId = (typeof customerEmailOauthProviderIds)[number];

export const customerEmailCapabilities = ["draft", "send"] as const;
export type CustomerEmailCapability = (typeof customerEmailCapabilities)[number];

export interface CustomerEmailProviderMetadata {
  id: CustomerEmailOauthProviderId;
  displayName: string;
  capabilities: CustomerEmailCapability[];
}

type ScopePolicy = Record<CustomerEmailCapability, string[]>;

export interface CustomerEmailOauthProviderCredentialConfig {
  googleMailClientId?: string;
  googleMailClientSecret?: string;
  microsoftGraphMailClientId?: string;
  microsoftGraphMailClientSecret?: string;
}

const providerMetadata: CustomerEmailProviderMetadata[] = [
  {
    id: "google_mail",
    displayName: "Google Gmail",
    capabilities: ["draft", "send"],
  },
  {
    id: "microsoft_graph_mail",
    displayName: "Microsoft 365 Outlook",
    capabilities: ["draft", "send"],
  },
];

const scopePolicies: Record<CustomerEmailOauthProviderId, ScopePolicy> = {
  google_mail: {
    draft: ["https://www.googleapis.com/auth/gmail.compose"],
    send: ["https://www.googleapis.com/auth/gmail.send"],
  },
  microsoft_graph_mail: {
    draft: ["Mail.ReadWrite"],
    send: ["Mail.Send"],
  },
};

const providerEndpoints: Record<CustomerEmailOauthProviderId, Pick<OauthProviderDefinition, "authorizationEndpoint" | "tokenEndpoint">> = {
  google_mail: {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
  },
  microsoft_graph_mail: {
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  },
};

const unique = (values: string[]): string[] => [...new Set(values)];

export const getCustomerEmailProviderMetadata = (): CustomerEmailProviderMetadata[] =>
  providerMetadata.map((provider) => ({
    ...provider,
    capabilities: [...provider.capabilities],
  }));

export const requiredCustomerEmailScopes = (
  providerId: CustomerEmailOauthProviderId,
  capabilities: CustomerEmailCapability[],
): string[] => unique(capabilities.flatMap((capability) => scopePolicies[providerId][capability]));

const allScopesForProvider = (providerId: CustomerEmailOauthProviderId): string[] =>
  requiredCustomerEmailScopes(providerId, [...customerEmailCapabilities]);

export const buildCustomerEmailOauthProviderDefinitions = (
  config: CustomerEmailOauthProviderCredentialConfig,
): OauthProviderDefinition[] => {
  const providers: OauthProviderDefinition[] = [];

  if (config.googleMailClientId && config.googleMailClientSecret) {
    const scopes = allScopesForProvider("google_mail");
    providers.push({
      id: "google_mail",
      ...providerEndpoints.google_mail,
      clientId: config.googleMailClientId,
      clientSecret: config.googleMailClientSecret,
      defaultScopes: scopes,
      allowedScopes: scopes,
    });
  }

  if (config.microsoftGraphMailClientId && config.microsoftGraphMailClientSecret) {
    const scopes = allScopesForProvider("microsoft_graph_mail");
    providers.push({
      id: "microsoft_graph_mail",
      ...providerEndpoints.microsoft_graph_mail,
      clientId: config.microsoftGraphMailClientId,
      clientSecret: config.microsoftGraphMailClientSecret,
      defaultScopes: scopes,
      allowedScopes: scopes,
    });
  }

  return providers;
};

export const assertCustomerEmailScopes = (
  providerId: CustomerEmailOauthProviderId,
  grantedScopes: string[],
  capabilities: CustomerEmailCapability[],
): void => {
  const granted = new Set(grantedScopes);
  const missing = requiredCustomerEmailScopes(providerId, capabilities).filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw badRequest("OAuth connection is missing required customer email scopes", { missingScopes: missing });
  }
};
