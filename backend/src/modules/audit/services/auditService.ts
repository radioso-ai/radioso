import type { RetrievalExecutionDiagnostics } from "../../retrieval/domain/retrievalPipelineTypes.js";
import { extractRetrievalLogFields, type AppLogger } from "../../../shared/observability/logger.js";

export interface AuditEventMetadata extends Record<string, unknown> {
  retrieval?: RetrievalExecutionDiagnostics;
}

export interface AuditEventInput {
  accountId?: string | null;
  eventType: string;
  eventStatus: "success" | "failure";
  metadata?: AuditEventMetadata;
}

export class AuditService {
  constructor(private readonly logger: AppLogger) {}

  async record(event: AuditEventInput): Promise<void> {
    this.logger.info(
      {
        audit: event,
        retrieval: extractRetrievalLogFields(event.metadata),
      },
      "audit_event",
    );
  }
}
