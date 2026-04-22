import type { AuditService } from "../../modules/audit/services/auditService.js";
import type { IncidentSink } from "./incidentSink.js";
import type { IncidentEvent } from "./incidentTypes.js";

export class AuditIncidentSink implements IncidentSink {
  constructor(private readonly auditService: AuditService) {}

  async record(event: IncidentEvent): Promise<void> {
    await this.auditService.record({
      accountId: event.correlation?.accountId ?? null,
      workspaceId: event.correlation?.workspaceId ?? null,
      eventType: "incident.recorded",
      eventStatus: event.severity === "error" ? "failure" : "success",
      metadata: {
        incident: event,
      },
    });
  }
}
