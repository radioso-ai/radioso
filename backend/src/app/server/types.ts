import type { ChatService } from "../../modules/chat/services/chatService.js";
import type { ChatHistoryService } from "../../modules/chat/services/chatHistoryService.js";
import type { DocumentDeletionService } from "../../modules/documents/services/documentDeletionService.js";
import type { DocumentIngestionService } from "../../modules/documents/services/documentIngestionService.js";
import type { DocumentImportService } from "../../modules/documents/services/documentImportService.js";
import type { DocumentProcessingWorker } from "../../modules/documents/services/documentProcessingWorker.js";
import type { RetrievalSettingsService } from "../../modules/settings/services/retrievalSettingsService.js";
import type { AuthService } from "../../modules/auth/services/authService.js";
import type { AuditService } from "../../modules/audit/services/auditService.js";
import type { WorkspaceService } from "../../modules/workspace/services/workspaceService.js";
import type { WorkspaceRepositoryPort } from "../../db/repositories/workspaceRepository.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { ConnectorRegistry } from "../../modules/connectors/services/connectorRegistry.js";
import type { Database } from "../../shared/infra/database.js";
import type { Env } from "../config/env.js";
import type { AppLogger } from "../../shared/observability/logger.js";

export interface AppDependencies {
  env: Env;
  logger: AppLogger;
  authService: AuthService;
  auditService: AuditService;
  workspaceService: WorkspaceService;
  retrievalSettingsService: RetrievalSettingsService;
  documentIngestionService: DocumentIngestionService;
  documentImportService: DocumentImportService;
  documentProcessingWorker: DocumentProcessingWorker;
  documentDeletionService: DocumentDeletionService;
  chatService: ChatService;
  chatHistoryService: ChatHistoryService;
  workspaceRepository: WorkspaceRepositoryPort;
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  connectorRegistry: ConnectorRegistry;
  connectorDb: Database;
}
