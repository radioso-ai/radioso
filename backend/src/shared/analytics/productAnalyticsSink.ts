import type { ProductAnalyticsEvent } from "./productAnalyticsTypes.js";

export interface ProductAnalyticsSink {
  emit(event: ProductAnalyticsEvent): Promise<void>;
}

export class NoopProductAnalyticsSink implements ProductAnalyticsSink {
  async emit(_event: ProductAnalyticsEvent): Promise<void> {}
}
