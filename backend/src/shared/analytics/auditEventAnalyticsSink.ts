import type { AuditService } from "../../modules/audit/contracts/index.js";
import type { ProductAnalyticsSink } from "./productAnalyticsSink.js";
import type { ProductAnalyticsEvent } from "./productAnalyticsTypes.js";

export class AuditEventAnalyticsSink implements ProductAnalyticsSink {
  constructor(private readonly auditService: AuditService) {}

  async emit(event: ProductAnalyticsEvent): Promise<void> {
    await this.auditService.record({
      accountId: event.accountId,
      workspaceId: event.workspaceId,
      eventType: "product.analytics",
      eventStatus: "success",
      metadata: {
        analytics: event,
      },
    });
  }
}
