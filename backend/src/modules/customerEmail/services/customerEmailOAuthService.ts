import {
  type OauthAuthorizationStartResult,
  type OauthConnectionCreateInput,
  type OauthConnectionSummary,
} from "../../integrationOauth/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  customerEmailOauthProviderIds,
  type CustomerEmailOauthProviderId,
} from "../oauthMailProviders.js";

export interface CustomerEmailOAuthPort {
  create(workspaceId: string, input: OauthConnectionCreateInput): Promise<OauthAuthorizationStartResult>;
  get(workspaceId: string, connectionId: string): Promise<OauthConnectionSummary>;
  reauthorize(workspaceId: string, connectionId: string): Promise<OauthAuthorizationStartResult>;
}

const customerEmailProviderIds = new Set<string>(customerEmailOauthProviderIds);

const assertCustomerEmailProvider = (provider: string): CustomerEmailOauthProviderId => {
  if (!customerEmailProviderIds.has(provider)) {
    throw badRequest("Unsupported customer email OAuth provider");
  }
  return provider as CustomerEmailOauthProviderId;
};

export class CustomerEmailOAuthService {
  constructor(private readonly oauth: CustomerEmailOAuthPort) {}

  async start(
    workspaceId: string,
    input: OauthConnectionCreateInput,
  ): Promise<OauthAuthorizationStartResult> {
    assertCustomerEmailProvider(input.provider);
    return this.oauth.create(workspaceId, input);
  }

  async getStatus(workspaceId: string, connectionId: string): Promise<OauthConnectionSummary> {
    const connection = await this.oauth.get(workspaceId, connectionId);
    if (!customerEmailProviderIds.has(connection.provider)) {
      throw badRequest("OAuth connection is not a customer email provider");
    }
    return connection;
  }

  async reauthorize(workspaceId: string, connectionId: string): Promise<OauthAuthorizationStartResult> {
    await this.getStatus(workspaceId, connectionId);
    return this.oauth.reauthorize(workspaceId, connectionId);
  }
}
