import type { CustomerEmailProviderAdapter, CustomerEmailProviderHealthResult } from "./customerEmailProvider.js";

export class MockCustomerEmailProviderAdapter implements CustomerEmailProviderAdapter {
  constructor(
    readonly provider: string,
    private readonly healthResult: CustomerEmailProviderHealthResult = { status: "ok" },
  ) {}

  async checkHealth(): Promise<CustomerEmailProviderHealthResult> {
    return this.healthResult;
  }
}
