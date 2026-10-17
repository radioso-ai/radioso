import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { DocumentRepositoryPort } from "../../documents/contracts/index.js";
import type { WorkspaceSetupStateRepositoryPort, WorkspaceSetupStep } from "../../../db/repositories/workspaceSetupStateRepository.js";

interface WorkspaceSummary {
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
  setup: {
    purpose: string | null;
    dismissed: boolean;
    skippedSteps: WorkspaceSetupStep[];
    shouldShowFirstRun: boolean;
    hasDirectivesOrRoutines: boolean;
    hasNotifyDestination: boolean;
    hasNotifyDeliveryConfirmed: boolean;
    hasCredential: boolean;
  };
}

export class WorkspaceSummaryService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly setupStateRepository: WorkspaceSetupStateRepositoryPort,
    private readonly featureFlags: { websiteCrawlerEnabled: boolean } = { websiteCrawlerEnabled: true },
  ) {}

  async updateSetupState(workspaceId: string, input: Parameters<WorkspaceSetupStateRepositoryPort["update"]>[1]): Promise<WorkspaceSummary> {
    await this.setupStateRepository.update(workspaceId, input);
    return this.getSummary(workspaceId);
  }

  async getSummary(workspaceId: string): Promise<WorkspaceSummary> {
    const [documentSummary, conversationCount, setupState, outcomes] = await Promise.all([
      this.documentRepository.summarizeWorkspace(workspaceId),
      this.conversationRepository.countByWorkspaceId(workspaceId),
      this.setupStateRepository.get(workspaceId),
      this.setupStateRepository.getOutcomeFlags(workspaceId),
    ]);

    // Projected field by field rather than spread: this summary is the onboarding
    // contract, so it must not grow silently when the document record does.
    return {
      documentCount: documentSummary.documentCount,
      readyDocumentCount: documentSummary.readyDocumentCount,
      pendingDocumentCount: documentSummary.pendingDocumentCount,
      sampleDocumentCount: documentSummary.sampleDocumentCount,
      sampleDocumentSlugs: documentSummary.sampleDocumentSlugs,
      conversationCount,
      hasDocuments: documentSummary.documentCount > 0,
      hasPendingDocuments: documentSummary.pendingDocumentCount > 0,
      hasReadyDocuments: documentSummary.readyDocumentCount > 0,
      hasCompletedChat: conversationCount > 0,
      sampleDocumentsImported: documentSummary.sampleDocumentCount > 0,
      websiteCrawlerEnabled: this.featureFlags.websiteCrawlerEnabled,
      setup: {
        purpose: setupState.purpose,
        dismissed: setupState.dismissedAt !== null,
        skippedSteps: setupState.skippedSteps,
        shouldShowFirstRun: setupState.dismissedAt === null && conversationCount === 0,
        hasDirectivesOrRoutines: outcomes.hasDirectivesOrRoutines,
        hasNotifyDestination: outcomes.hasNotifyDestination,
        hasNotifyDeliveryConfirmed: outcomes.hasNotifyDeliveryConfirmed,
        hasCredential: outcomes.hasCredential,
      },
    };
  }
}
