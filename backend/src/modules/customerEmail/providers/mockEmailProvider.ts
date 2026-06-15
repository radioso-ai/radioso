import type {
  CustomerEmailMessageInput,
  CustomerEmailProviderAdapter,
  CustomerEmailProviderDeliveryResult,
  CustomerEmailProviderHealthResult,
} from "./customerEmailProvider.js";

export class MockCustomerEmailProviderAdapter implements CustomerEmailProviderAdapter {
  constructor(
    readonly provider: string,
    private readonly healthResult: CustomerEmailProviderHealthResult = { status: "ok" },
    private readonly deliveryResult: CustomerEmailProviderDeliveryResult = { providerMessageId: "mock-email-message" },
  ) {}

  async checkHealth(): Promise<CustomerEmailProviderHealthResult> {
    return this.healthResult;
  }

  async createDraft(_input: CustomerEmailMessageInput): Promise<CustomerEmailProviderDeliveryResult> {
    return this.deliveryResult;
  }

  async sendMessage(_input: CustomerEmailMessageInput): Promise<CustomerEmailProviderDeliveryResult> {
    return this.deliveryResult;
  }
}
