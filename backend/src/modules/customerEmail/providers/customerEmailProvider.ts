import type { CustomerEmailHealthStatus } from "../domain.js";

export interface CustomerEmailMessageInput {
  accessToken: string;
  workspaceId: string;
  connectionId: string;
  senderEmail: string;
  senderName: string | null;
  replyToEmail: string | null;
  to: string;
  cc?: string | null;
  subject: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  replyTo?: string | null;
}

export interface CustomerEmailProviderDeliveryResult {
  providerMessageId?: string | null;
}

export class CustomerEmailProviderRejectedError extends Error {
  constructor(message = "Customer email provider rejected the message") {
    super(message);
    this.name = "CustomerEmailProviderRejectedError";
  }
}

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
  createDraft?(input: CustomerEmailMessageInput): Promise<CustomerEmailProviderDeliveryResult>;
  sendMessage?(input: CustomerEmailMessageInput): Promise<CustomerEmailProviderDeliveryResult>;
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
