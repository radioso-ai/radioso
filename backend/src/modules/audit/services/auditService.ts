import type { AppLogger } from "../../../shared/observability/logger.js";

export interface AuditEventInput {
  accountId?: string | null;
  eventType: string;
  eventStatus: "success" | "failure";
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly logger: AppLogger) {}

  async record(event: AuditEventInput): Promise<void> {
    this.logger.info({ audit: event }, "audit_event");
  }
}
