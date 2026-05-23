import type { AuditService } from "../../modules/audit/contracts/index.js";
import type { ErrorSink } from "./errorSink.js";
import type { ErrorEvent } from "./errorTypes.js";

export class AuditErrorSink implements ErrorSink {
  constructor(private readonly auditService: AuditService) {}

  async record(event: ErrorEvent): Promise<void> {
    await this.auditService.record({
      accountId: event.correlation?.accountId ?? null,
      workspaceId: event.correlation?.workspaceId ?? null,
      eventType: "error.recorded",
      eventStatus: event.severity === "error" ? "failure" : "success",
      metadata: {
        error: event,
      },
    });
  }
}
