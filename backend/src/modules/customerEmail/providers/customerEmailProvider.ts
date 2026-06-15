import type { CustomerEmailHealthStatus } from "../domain.js";

export interface CustomerEmailProviderHealthResult {
  status: Exclude<CustomerEmailHealthStatus, "unknown">;
  errorCode?: string | null;
}

export interface CustomerEmailProviderAdapter {
  provider: string;
  checkHealth(input: {
    workspaceId: string;
    connectionId: string;
    oauthConnectionId: string;
    senderEmail: string;
  }): Promise<CustomerEmailProviderHealthResult>;
}

export interface CustomerEmailProviderRegistryPort {
  get(provider: string): CustomerEmailProviderAdapter | null;
}

export class StaticCustomerEmailProviderRegistry implements CustomerEmailProviderRegistryPort {
  private readonly providers: Map<string, CustomerEmailProviderAdapter>;

  constructor(providers: CustomerEmailProviderAdapter[]) {
    this.providers = new Map(providers.map((provider) => [provider.provider, provider]));
  }

  get(provider: string): CustomerEmailProviderAdapter | null {
    return this.providers.get(provider) ?? null;
  }
}
