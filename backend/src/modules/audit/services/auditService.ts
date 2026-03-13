import type { RetrievalExecutionDiagnostics } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
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
  constructor(
    private readonly logger: AppLogger,
    private readonly auditEventRepository: AuditEventRepositoryPort,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    await this.auditEventRepository.create({
      accountId: event.accountId,
      eventType: event.eventType,
      eventStatus: event.eventStatus,
      metadata: event.metadata,
    });

    this.logger.info(
      {
        audit: event,
        retrieval: extractRetrievalLogFields(event.metadata),
      },
      "audit_event",
    );
  }
}
