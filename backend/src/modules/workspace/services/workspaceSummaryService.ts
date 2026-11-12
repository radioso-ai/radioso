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
      setup: projectSetup(setupState, outcomes, conversationCount > 0),
    };
  }

  /**
   * The setup facts without the counts. Ray reads these on every turn, so the two booleans that
   * need the documents and conversations tables are answered with EXISTS: a workspace with a long
   * history must not pay a scan on each question to learn that one document is ready.
   */
  async getSetupSignals(workspaceId: string): Promise<Pick<WorkspaceSummary, "hasReadyDocuments" | "hasCompletedChat" | "setup">> {
    const [hasReadyDocuments, hasCompletedChat, setupState, outcomes] = await Promise.all([
      this.documentRepository.hasReadyDocuments(workspaceId),
      this.conversationRepository.hasAnyForWorkspace(workspaceId),
      this.setupStateRepository.get(workspaceId),
      this.setupStateRepository.getOutcomeFlags(workspaceId),
    ]);
    return { hasReadyDocuments, hasCompletedChat, setup: projectSetup(setupState, outcomes, hasCompletedChat) };
  }
}

const projectSetup = (
  setupState: Awaited<ReturnType<WorkspaceSetupStateRepositoryPort["get"]>>,
  outcomes: Awaited<ReturnType<WorkspaceSetupStateRepositoryPort["getOutcomeFlags"]>>,
  hasConversation: boolean,
): WorkspaceSummary["setup"] => ({
  purpose: setupState.purpose,
  dismissed: setupState.dismissedAt !== null,
  skippedSteps: setupState.skippedSteps,
  shouldShowFirstRun: setupState.dismissedAt === null && !hasConversation,
  hasDirectivesOrRoutines: outcomes.hasDirectivesOrRoutines,
  hasNotifyDestination: outcomes.hasNotifyDestination,
  hasNotifyDeliveryConfirmed: outcomes.hasNotifyDeliveryConfirmed,
  hasCredential: outcomes.hasCredential,
});
