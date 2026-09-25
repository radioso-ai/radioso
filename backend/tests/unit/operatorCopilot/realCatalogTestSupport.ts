import { vi } from "vitest";

import { createCopilotToolDescriptors } from "../../../src/modules/operatorCopilot/tools/index.js";
import { copilotProposalTargetTypes } from "../../../src/modules/operatorCopilot/contracts.js";
import type { createCopilotToolCatalog } from "../../../src/app/composition/copilotToolCatalog.js";

/**
 * Builds the dependency stubs for the REAL composition barrel rather than re-wiring tool
 * factories by hand. Tests that build descriptors factory-by-factory wire dependencies
 * correctly themselves and can never catch the barrel wiring them wrongly — which is exactly how
 * a dead tool and a dead name-resolution path both reached main.
 */
export const realCatalogDependencies = () => {
  const stub = () => vi.fn(async () => { throw new Error("not exercised: these tests only resolve entities"); });
  const agentService = {
    listExisting: vi.fn(async () => [{ id: "agent-1", name: "Support" }]),
    resolve: stub(),
    get: stub(),
  };
  return {
    agentService,
    routineDefinitionService: { list: stub(), get: stub(), validate: stub() },
    chatHistoryService: { getConversation: stub(), getConversationTurn: stub(), listConversations: stub() },
    documentSearchService: { search: stub() },
    documentChunks: { listPageForDocument: stub() },
    documentMaintenance: { reprocessDocument: stub(), reprocessSource: stub(), recrawlSource: stub() },
    documentStatusService: { summarize: stub() },
    evalResultsService: { listWithLatestRun: stub() },
    replyDraft: { draft: stub() },
    qualitySignalsService: { getQualityStats: stub(), listLowQualityTurns: stub() },
    qualityTriageService: { triageStates: ["open"] as [string, ...string[]], resolutionReasons: ["knowledge_gap"] as [string, ...string[]], setTriageState: stub() },
    retrievalProbe: { probe: stub() },
    testChat: { listSessions: stub(), readSession: stub(), readTurn: stub(), sendMessage: stub() },
    audiencePulseService: { read: stub() },
    agentSkillsService: { list: stub() },
    skillCapabilityTargets: { list: stub() },
    contextVariables: { listByWorkspace: stub(), listByAgent: stub() },
    workspaceSettings: {
      getRetrievalDefaults: stub(), getIngestionSettings: stub(), listLlmModels: stub(), getManagedLlmModels: stub(),
      getProviderCredentialHealth: stub(), getGeneralSettings: stub(),
    },
    proposalRepository: { createProposal: stub() },
    proposalAdapters: copilotProposalTargetTypes.map((targetType) => ({
      targetType, draft: stub(), preview: stub(), applyIfVersionMatches: stub(), validatePayload: stub(),
    })),
    auditService: { record: stub() },
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
  } as unknown as Parameters<typeof createCopilotToolCatalog>[0];
};

/** The complete production descriptor catalog, assembled through the real factory. */
export const realCatalog = () => createCopilotToolDescriptors(
  realCatalogDependencies(),
);
