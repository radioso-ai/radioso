import type { ConversationModelGateway } from "@radioso/conversation-contract";
import { createDirectiveCoherenceChecker, scopeTag } from "@radioso/conversation-defaults";
import type { ApplicationComposition } from "../../composition/index.js";
import { bindSkillCapabilityExecutors } from "../../composition/skillCapabilityRegistry.js";
import { AgentService, AuthoredDirectiveService, DirectiveAuthorService } from "../../../modules/agents/public.js";
import { AgentSkillRepository } from "../../../modules/agentSkills/public.js";
import type { AccessGrantService } from "../../../modules/accessGrants/public.js";
import {
  RoutineDefinitionService,
  RoutineDraftAssistService,
  RoutineTriggerEmbeddingService,
} from "../../../modules/routines/public.js";
import { PlatformSettingsService } from "../../../modules/settings/composition.js";
import type { ContextVariableEnablementReaderPort } from "../../../modules/context-variables/public.js";
import type {
  ExternalSkillDefinitionService,
} from "../../../modules/externalSkills/services/externalSkillDefinitionService.js";
import type { SkillAuthoringCatalog } from "../../../modules/skills/public.js";
import {
  SkillAuthoringCatalogService,
  SkillCatalogService,
  routineAuthoringBuiltInSkills,
  type SkillCapabilityRegistry,
  type RoutineInvocableSkillNames,
} from "../../../modules/skills/public.js";
import type { WebhookDestinationExistencePort } from "../../../modules/webhooks/public.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { registeredCapabilityNames } from "../../../shared/domain/capabilityPolicy.js";
import type { buildInfrastructure, buildRepositories } from "./infra.js";



const directiveCoherenceInvocationContext = (
  metadata: Record<string, unknown> | undefined,
): { workspaceId: string; agentId: string } => {
  const context = metadata?.invocationContext;
  if (
    !context
    || typeof context !== "object"
    || Array.isArray(context)
    || typeof (context as Record<string, unknown>).workspaceId !== "string"
    || typeof (context as Record<string, unknown>).agentId !== "string"
  ) {
    throw new Error("directive_coherence_invocation_context_required");
  }
  return {
    workspaceId: (context as Record<string, string>).workspaceId,
    agentId: (context as Record<string, string>).agentId,
  };
};

const createConversationModelGateway = (pipeline: ModelInferencePipeline): ConversationModelGateway => ({
  async complete(input) {
    const invocationContext = directiveCoherenceInvocationContext(input.metadata);
    const { text } = await pipeline.complete({
      prompt: input.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
      systemPrompt: input.systemPrompt,
      operation: {
        workspaceId: invocationContext.workspaceId,
        agentId: invocationContext.agentId,
        surface: "agents",
        operation: "directive_coherence",
        attemptKey: String(input.metadata?.candidateDirectiveName ?? "candidate"),
      },
    });
    return {
      text,
      metadata: {
        capability: pipeline.metadata.capability,
        provider: pipeline.metadata.provider,
        model: pipeline.metadata.model,
      },
    };
  },
});

export const buildSkillCatalogServices = (input: {
  accessGrantService: AccessGrantService;
  agentService: AgentService;
  agentSkillRepository: AgentSkillRepository;
  composition: ApplicationComposition;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
  skillCapabilityRegistry: SkillCapabilityRegistry;
  externalSkillDefinitionService: ExternalSkillDefinitionService;
  publicChatBaseUrl: string | undefined;
}) => {
  const platformSettingsService = new PlatformSettingsService({
    workspaceRepository: input.repositories.workspaceRepository,
    agentService: input.agentService,
    accessGrantService: input.accessGrantService,
    auditService: input.infrastructure.auditService,
    logger: input.logger,
    publicChatBaseUrl: input.publicChatBaseUrl,
    websiteEmbedIntegration: input.composition.websiteEmbedIntegration,
  });
  const skillCatalogService = new SkillCatalogService({
    capabilityPolicy: input.composition.capabilityPolicy,
    registry: input.composition.skillCatalogRegistry,
  });
  const skillAuthoringCatalog = new SkillAuthoringCatalogService({
    skillCatalog: skillCatalogService,
    externalSkills: input.externalSkillDefinitionService,
    agentSkills: input.agentSkillRepository,
    capabilities: input.skillCapabilityRegistry,
    logger: input.logger,
  });
  const skillCapabilityBindings = bindSkillCapabilityExecutors({
    capabilities: input.skillCapabilityRegistry,
    executors: input.composition.skillExecutorRegistry,
  });
  const unboundCapabilities = skillCapabilityBindings.filter((binding) => !binding.bound);
  if (unboundCapabilities.length > 0) {
    input.logger.warn(
      {
        event: "skill_capability_executor_unbound",
        capabilities: unboundCapabilities.map((binding) => ({
          capability: binding.capabilityId,
          executorAdapter: binding.executorAdapter,
        })),
      },
      "One or more skill capabilities have no bound executor; skills using them will fail at dispatch",
    );
  }
  return { platformSettingsService, skillAuthoringCatalog, skillCatalogService };
};

export const buildRoutineAuthoringServices = (input: {
  agentSkillRepository: AgentSkillRepository;
  chatInferencePipeline: ModelInferencePipeline;
  composition: ApplicationComposition;
  contextVariableReader: ContextVariableEnablementReaderPort;
  infrastructure: ReturnType<typeof buildInfrastructure>;
  logger: AppLogger;
  repositories: ReturnType<typeof buildRepositories>;
  routineInvocableSkillNames: RoutineInvocableSkillNames;
  routineTriggerEmbeddingService: RoutineTriggerEmbeddingService;
  skillAuthoringCatalog: SkillAuthoringCatalog;
  webhookDestinations: WebhookDestinationExistencePort;
}) => {
  const authoredDirectiveService = new AuthoredDirectiveService({
    repository: input.repositories.agentRepository,
    coherenceChecker: createDirectiveCoherenceChecker({
      modelGateway: createConversationModelGateway(input.chatInferencePipeline),
    }),
    registeredCapabilityNames,
    agentSkills: input.agentSkillRepository,
  });
  const routineDefinitionService = new RoutineDefinitionService({
    agentRepository: input.repositories.agentRepository,
    repository: input.repositories.routineDefinitionRepository,
    actionCapabilities: input.composition.actionCapabilityMap,
    capabilityPolicy: input.composition.capabilityPolicy,
    skillAuthoringCatalog: input.skillAuthoringCatalog,
    contextVariableReader: input.contextVariableReader,
    additionalRoutineSkillNames: (context) => input.routineInvocableSkillNames.listForAgent(context),
    webhookDestinations: {
      existsByIdAndWorkspace: async (workspaceId, destinationId) =>
        input.webhookDestinations.existsByIdAndWorkspace(workspaceId, destinationId),
    },
    auditService: input.infrastructure.auditService,
    directiveScopeTags: input.repositories.agentRepository,
    triggerEmbeddingService: input.routineTriggerEmbeddingService,
  });
  const routineDraftAssistService = new RoutineDraftAssistService({
    repository: input.repositories.agentRepository,
    textGenerationClient: {
      complete: async ({ signal: _signal, ...request }) =>
        (await input.chatInferencePipeline.complete(request)).text,
    },
    actionCatalog: [
      ...routineAuthoringBuiltInSkills.map((skill) => ({
        type: skill.name,
        kind: "tool" as const,
        label: skill.displayName,
        description: skill.description,
        outcomeStatuses: skill.outcomes?.map((outcome) => outcome.name),
      })),
      ...input.composition.actionHandlerRegistrations.map((registration) => ({
        type: registration.type,
        kind: "action" as const,
      })),
    ],
    skillAuthoringCatalog: input.skillAuthoringCatalog,
    logger: input.logger,
    telemetryService: input.infrastructure.telemetryService,
  });
  const directiveAuthorService = new DirectiveAuthorService({
    repository: input.repositories.agentRepository,
    textGenerationClient: {
      complete: async ({ signal: _signal, ...request }) =>
        (await input.chatInferencePipeline.complete(request)).text,
    },
    logger: input.logger,
    telemetryService: input.infrastructure.telemetryService,
    buildStepScopeTag: scopeTag.step,
  });
  return { authoredDirectiveService, directiveAuthorService, routineDefinitionService, routineDraftAssistService };
};
