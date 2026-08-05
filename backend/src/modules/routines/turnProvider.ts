import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import type {
  ConversationModelGateway,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineRunner,
  ConversationRoutineSlotCorrection,
  Routine,
} from "@radioso/conversation-contract";
import {
  RoutineRegistry,
  RoutineNextStepSelector,
  RoutineReentryGate,
  RoutineSlotCorrector,
  RoutineStepRenderer,
  type RoutineActivationPrefilter,
  type RoutineGroundedAnswerRenderer,
  type RoutineRegistration,
} from "@radioso/conversation-defaults";

import type { AgentSkillRepositoryPort } from "../agentSkills/public.js";
import type { ClusteringEmbeddingPort } from "../embeddingProfiles/contracts/embeddingConsumers.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import { registeredCapabilityNames } from "../../shared/domain/capabilityPolicy.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { SkillExecutorRegistry } from "../skills/public.js";
import {
  routineDispatchableBuiltInSkills,
  type RoutineInvocableSkillNames,
} from "../skills/public.js";
import { RetrieveRoutineSkillResolver } from "../retrieval/public.js";
import { ExternalSkillRoutineSkillResolver } from "../externalSkills/public.js";
import {
  CustomerEmailRoutineSkillResolver,
} from "../customerEmail/public.js";
import { SlackRoutineSkillResolver } from "../slackSkills/public.js";
import { WebhookRoutineSkillResolver } from "../webhookSkills/public.js";
import {
  RoutineSkillExecutorDispatcher,
  StaticRoutineSkillResolver,
} from "./skillDispatcher.js";
import type { RoutineTriggerEmbeddingService } from "./routineTriggerEmbeddingService.js";
import { createRoutineActivationPrefilter } from "./routineActivationPrefilter.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";

export interface RoutineRegistrationSource {
  load(input: { agentId: string }): Promise<RoutineRegistration[]>;
  loadPinned(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
  loadPreview(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
}

export interface RoutineTurnPlanAdapters {
  activator(input: {
    handle?: unknown;
    registry: RoutineRegistry;
    fallback: ConversationRoutineActivator;
  }): ConversationRoutineActivator;
  reentryGate(input: {
    handle?: unknown;
    fallback: ConversationRoutineReentryGate;
  }): ConversationRoutineReentryGate;
  slotCorrection(input: {
    handle?: unknown;
    fallback: ConversationRoutineSlotCorrection;
  }): ConversationRoutineSlotCorrection;
}

export interface RoutineTurnProviderDependencies {
  agentSkillRepository: Pick<AgentSkillRepositoryPort, "listByAgent">;
  capabilityPolicy: Pick<CapabilityPolicy, "can">;
  clusteringEmbeddings: ClusteringEmbeddingPort;
  embeddingModelForWorkspace: (workspaceId: string) => Promise<string>;
  logger: Pick<AppLogger, "debug" | "warn">;
  metricsRegistry?: MetricsRegistry | null;
  publishedRoutineSource: RoutineRegistrationSource;
  routineDefinitionRepository: Parameters<typeof createRoutineActivationPrefilter>[0]["routineDefinitionRepository"];
  routineInvocableSkillNames: RoutineInvocableSkillNames;
  routineRegistrations: readonly RoutineRegistration[];
  routineTriggerEmbeddingService: Pick<RoutineTriggerEmbeddingService, "persistPublished">;
  skillExecutorRegistry: SkillExecutorRegistry;
  turnPlanAdapters: RoutineTurnPlanAdapters;
}

export interface RoutineTurnProvider {
  forTurn(input: {
    modelGateway: ConversationModelGateway;
    agentId: string;
    workspaceId?: string;
    accountId?: string;
    pinnedRoutineIds?: string[];
    previewRoutineIds?: string[];
    responseLanguage?: string | Promise<string | undefined>;
    groundedAnswerRenderer?: RoutineGroundedAnswerRenderer;
    throwIfCancelled?: () => void;
    turnPlan?: unknown;
  }): Promise<{
    routines?: readonly Routine[];
    activator: ConversationRoutineActivator;
    runner: ConversationRoutineRunner;
    slotCorrection?: ConversationRoutineSlotCorrection;
    reentryGate?: ConversationRoutineReentryGate;
  } | null>;
}

const routineActivationPolicy = { floor: 0.4, margin: 0.15, askMargin: 0.15, maxOptions: 4 };

export const createRoutineTurnProvider = (
  dependencies: RoutineTurnProviderDependencies,
): RoutineTurnProvider => ({
  async forTurn({
    modelGateway,
    agentId,
    workspaceId,
    accountId,
    pinnedRoutineIds = [],
    previewRoutineIds = [],
    responseLanguage,
    groundedAnswerRenderer,
    throwIfCancelled,
    turnPlan,
  }) {
    let publishedRegistrations: RoutineRegistration[];
    try {
      publishedRegistrations = await dependencies.publishedRoutineSource.load({ agentId });
    } catch (error) {
      dependencies.logger.warn(
        { agentId, err: error instanceof Error ? error.message : String(error) },
        "Published routine definitions failed to load; continuing without DB-backed routines",
      );
      publishedRegistrations = [];
    }

    // Operator-only workbench test override: make specific draft (or any-status)
    // definitions eligible this turn so an author can test-run an unpublished routine.
    let previewRegistrations: RoutineRegistration[] = [];
    if (previewRoutineIds.length > 0) {
      try {
        previewRegistrations = await dependencies.publishedRoutineSource.loadPreview({
          agentId,
          routineIds: previewRoutineIds,
        });
      } catch (error) {
        dependencies.logger.warn(
          { agentId, routineIds: previewRoutineIds, err: error instanceof Error ? error.message : String(error) },
          "Preview routine definitions failed to load; continuing without workbench draft routines",
        );
      }
    }

    let pinnedRegistrations: RoutineRegistration[];
    try {
      pinnedRegistrations = await dependencies.publishedRoutineSource.loadPinned({
        agentId,
        routineIds: pinnedRoutineIds,
      });
    } catch (error) {
      dependencies.logger.warn(
        { agentId, routineIds: pinnedRoutineIds, err: error instanceof Error ? error.message : String(error) },
        "Pinned routine definitions failed to load; continuing without resume-only DB-backed routines",
      );
      pinnedRegistrations = [];
    }

    const registrations = [
      ...dependencies.routineRegistrations,
      ...publishedRegistrations,
      ...previewRegistrations,
    ];
    const gatedRegistrations: RoutineRegistration[] = [];
    for (const registration of registrations) {
      const gateRef = registration.trigger.gateRef;
      if (!gateRef || !registeredCapabilityNames.has(gateRef)) {
        gatedRegistrations.push(registration);
        continue;
      }
      const decision = await dependencies.capabilityPolicy.can({ capability: gateRef, workspaceId });
      if (decision.allowed) {
        gatedRegistrations.push(registration);
      }
    }

    const routineRegistry = new RoutineRegistry(gatedRegistrations, {
      policy: routineActivationPolicy,
      promptTemplate: loadPromptTemplate("chat/routine-ranked-activation.md"),
      ...(workspaceId
        ? {
            activationPrefilter: createRoutineActivationPrefilter({
              accountId,
              clusteringEmbeddings: dependencies.clusteringEmbeddings,
              embeddingModelForWorkspace: dependencies.embeddingModelForWorkspace,
              logger: dependencies.logger,
              routineDefinitionRepository: dependencies.routineDefinitionRepository,
              selfHealTriggerEmbedding: ({ routineId, description, embedding, model }) => {
                void dependencies.routineTriggerEmbeddingService.persistPublished({
                  workspaceId,
                  agentId,
                  routine: { id: routineId, activation: { triggerDescription: description } },
                  precomputed: { embedding, model },
                });
              },
              workspaceId,
            }),
          }
        : {}),
    });

    const routinesById = new Map(routineRegistry.routines.map((routine) => [routine.id, routine]));
    for (const registration of pinnedRegistrations) {
      routinesById.set(registration.routine.id, registration.routine);
    }
    for (const registration of previewRegistrations) {
      routinesById.set(registration.routine.id, registration.routine);
    }
    const routines = [...routinesById.values()];
    if (routineRegistry.isEmpty && routines.length === 0) {
      return null;
    }

    let emailSkillNames: string[] = [];
    let webhookSkillNames: string[] = [];
    let slackSkillNames: string[] = [];
    let retrieveSkills: Array<{
      skillName: string;
      enabled: boolean;
      invocationMode: string;
      config?: Record<string, unknown>;
    }> = [];
    try {
      if (workspaceId) {
        const byKind = await dependencies.routineInvocableSkillNames.listByKindForAgent({ workspaceId, agentId });
        emailSkillNames = [...byKind.customer_email];
        webhookSkillNames = [...byKind.webhook];
        slackSkillNames = [...byKind.slack];
      }
    } catch (error) {
      dependencies.logger.warn(
        { agentId, err: error instanceof Error ? error.message : String(error) },
        "Routine-invocable skill names failed to load for routine routing; continuing without webhook, customer email, and Slack skills",
      );
    }
    try {
      if (workspaceId) {
        retrieveSkills = (await dependencies.agentSkillRepository.listByAgent(workspaceId, agentId))
          .filter((skill) => skill.kind === "retrieve")
          .map((skill) => ({
            skillName: skill.skillName,
            enabled: skill.enabled,
            invocationMode: skill.invocationMode,
            config: skill.config,
          }));
      }
    } catch (error) {
      dependencies.logger.warn(
        { agentId, err: error instanceof Error ? error.message : String(error) },
        "Retrieve skill definitions failed to load for routine routing; continuing without retrieve skills",
      );
    }

    return {
      routines,
      activator: routineRegistry.isEmpty
        ? { activate: async () => null }
        : dependencies.turnPlanAdapters.activator({
            handle: turnPlan,
            registry: routineRegistry,
            fallback: routineRegistry.activator(modelGateway),
          }),
      slotCorrection: dependencies.turnPlanAdapters.slotCorrection({
        handle: turnPlan,
        fallback: new RoutineSlotCorrector(routines, modelGateway, {
          detectPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-detect.md"),
          confirmPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-confirm.md"),
          invalidPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-invalid.md"),
        }),
      }),
      reentryGate: dependencies.turnPlanAdapters.reentryGate({
        handle: turnPlan,
        fallback: new RoutineReentryGate(routines, modelGateway, {
          promptTemplate: loadPromptTemplate("chat/routine-reentry-gate.md"),
        }),
      }),
      runner: new DefaultRoutineRunner(
        routines,
        new RoutineNextStepSelector(modelGateway, {
          promptTemplate: loadPromptTemplate("chat/routine-next-step.md"),
        }),
        new RoutineStepRenderer(modelGateway, {
          promptTemplate: loadPromptTemplate("chat/routine-step-reply.md"),
          terminalHandoffWithMessagePromptTemplate: loadPromptTemplate("chat/routine-step-terminal-handoff-with-message.md"),
          terminalHandoffDefaultPromptTemplate: loadPromptTemplate("chat/routine-step-terminal-handoff-default.md"),
          responseLanguage,
          groundedAnswerRenderer,
        }),
        new RoutineSkillExecutorDispatcher(
          new StaticRoutineSkillResolver(
            routineDispatchableBuiltInSkills,
            new WebhookRoutineSkillResolver(
              webhookSkillNames,
              new CustomerEmailRoutineSkillResolver(
                emailSkillNames,
                new SlackRoutineSkillResolver(
                  slackSkillNames,
                  new RetrieveRoutineSkillResolver(retrieveSkills, new ExternalSkillRoutineSkillResolver()),
                ),
              ),
            ),
          ),
          dependencies.skillExecutorRegistry,
          {
            workspaceId,
            ...(accountId ? { accountId } : {}),
            capabilityGate: (capability) => dependencies.capabilityPolicy.can({ capability, workspaceId }),
            metricsRegistry: dependencies.metricsRegistry ?? null,
            throwIfCancelled,
          },
        ),
      ),
    };
  },
});
