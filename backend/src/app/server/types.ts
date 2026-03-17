import type { ChatService } from "../../modules/chat/services/chatService.js";
import type { ChatHistoryService } from "../../modules/chat/services/chatHistoryService.js";
import type { DocumentDeletionService } from "../../modules/documents/services/documentDeletionService.js";
import type { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import type { DocumentProcessingWorker } from "../../modules/documents/services/documentProcessingWorker.js";
import type { RetrievalSettingsService } from "../../modules/settings/services/retrievalSettingsService.js";
import type { AuthService } from "../../modules/auth/services/authService.js";
import type { AuditService } from "../../modules/audit/services/auditService.js";
import type { Env } from "../config/env.js";
import type { AppLogger } from "../../shared/observability/logger.js";

export interface AppDependencies {
  env: Env;
  logger: AppLogger;
  authService: AuthService;
  auditService: AuditService;
  retrievalSettingsService: RetrievalSettingsService;
  documentIngestionService: DocumentIngestionService;
  documentProcessingWorker: DocumentProcessingWorker;
  documentDeletionService: DocumentDeletionService;
  chatService: ChatService;
  chatHistoryService: ChatHistoryService;
}
