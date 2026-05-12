import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { DocumentRepositoryPort } from "../../documents/contracts/index.js";

export interface WorkspaceSummary {
  documentCount: number;
  readyDocumentCount: number;
  pendingDocumentCount: number;
  sampleDocumentCount: number;
  sampleDocumentSlugs: string[];
  conversationCount: number;
  hasDocuments: boolean;
  hasPendingDocuments: boolean;
  hasReadyDocuments: boolean;
  hasCompletedChat: boolean;
  sampleDocumentsImported: boolean;
  websiteCrawlerEnabled: boolean;
}

export class WorkspaceSummaryService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly featureFlags: { websiteCrawlerEnabled: boolean } = { websiteCrawlerEnabled: true },
  ) {}

  async getSummary(workspaceId: string): Promise<WorkspaceSummary> {
    const [documentSummary, conversationCount] = await Promise.all([
      this.documentRepository.summarizeWorkspace(workspaceId),
      this.conversationRepository.countByWorkspaceId(workspaceId),
    ]);

    return {
      ...documentSummary,
      conversationCount,
      hasDocuments: documentSummary.documentCount > 0,
      hasPendingDocuments: documentSummary.pendingDocumentCount > 0,
      hasReadyDocuments: documentSummary.readyDocumentCount > 0,
      hasCompletedChat: conversationCount > 0,
      sampleDocumentsImported: documentSummary.sampleDocumentCount > 0,
      websiteCrawlerEnabled: this.featureFlags.websiteCrawlerEnabled,
    };
  }
}
