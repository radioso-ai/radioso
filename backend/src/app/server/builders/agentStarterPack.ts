import { buildStarterPackApplyService, buildStarterPackDraftService } from "../../composition/agentStarterPackComposition.js";
import type { ChatReadiness } from "../../../shared/infra/llm/chatReadiness.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { LlmProviderRegistry } from "../../../shared/infra/llm/providerRegistry.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { LlmResponseLanguageDetector } from "../../../shared/services/responseLanguageDetector.js";
import type { buildInfrastructure, buildRepositories } from "./infra.js";
import type { buildRoutineAuthoringServices } from "./skillsRoutines.js";

/**
 * The agent starter pack's draft and apply services. Both run through the routine authoring
 * services: drafting reads names and drafts the routine with them, and apply writes through them.
 */
export const buildAgentStarterPackServices = (input: {
  infrastructure: ReturnType<typeof buildInfrastructure>;
  repositories: ReturnType<typeof buildRepositories>;
  routineAuthoring: ReturnType<typeof buildRoutineAuthoringServices>;
  chatInferencePipeline: ModelInferencePipeline;
  llmRegistry: Pick<LlmProviderRegistry, "createRewriteInferencePipeline">;
  chatReadiness: Pick<ChatReadiness, "assertChatConfigured">;
  logger: AppLogger;
}) => {
  const { infrastructure, routineAuthoring } = input;
  return {
    starterPackDraftService: buildStarterPackDraftService({
      agentRepository: input.repositories.agentRepository,
      authoredDirectiveService: routineAuthoring.authoredDirectiveService,
      routineDefinitionService: routineAuthoring.routineDefinitionService,
      routineDraftAssistService: routineAuthoring.routineDraftAssistService,
      chatInferencePipeline: input.chatInferencePipeline,
      // Language detection is a short classification call, so it runs on the rewrite tier, as chat's own detector does.
      languageDetector: new LlmResponseLanguageDetector(
        input.llmRegistry.createRewriteInferencePipeline(infrastructure.usageEventRecorder),
      ),
      chatReadiness: input.chatReadiness,
      logger: input.logger,
      telemetryService: infrastructure.telemetryService,
    }),
    starterPackApplyService: buildStarterPackApplyService({
      db: infrastructure.database.kysely,
      authoredDirectiveService: routineAuthoring.authoredDirectiveService,
      authoringServicesOn: routineAuthoring.authoringServicesOn,
      routineDefinitionService: routineAuthoring.routineDefinitionService,
      auditService: infrastructure.auditService,
      logger: input.logger,
    }),
  };
};
