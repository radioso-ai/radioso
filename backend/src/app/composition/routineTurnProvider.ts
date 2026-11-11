import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { RoutineConsentRepository } from "../../db/repositories/routineConsentRepository.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import type { AgentSkillRepository } from "../../modules/agentSkills/public.js";
import {
  planAwareRoutineActivator,
  planAwareRoutineReentryGate,
  planAwareRoutineSlotCorrection,
  type ChatRoutineProvider,
} from "../../modules/chat/composition.js";
import { createRoutineTurnProvider } from "../../modules/routines/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { ApplicationComposition } from "./defaultComposition.js";
import { createPublishedRoutineRegistrationSource } from "./routineDefinitionSource.js";

type RoutineTurnProviderDependencies = Parameters<typeof createRoutineTurnProvider>[0];

/** The chat turn plan the routines module carries without reading; the plan-aware adapters read it. */
type ChatTurnPlanHandle = Parameters<typeof planAwareRoutineActivator>[0]["handle"];

/**
 * The routine machinery a chat turn consults (spec 070 / #520). The routines module loads the
 * per-turn catalog, applies capability gates, and assembles the runtime ports; this picks the
 * published routine source and hands the turn plan's adapters to it. The source is the
 * composition's own, or one over the definition repository and the agent's releases that logs a
 * definition it cannot compile and skips it, and sends a routine's completion export to the
 * agent's `completion_export` webhook skill. A routine's consents read what each conversation
 * recorded from the consent records (#1544).
 */
export const composeRoutineTurnProvider = (
  input: Pick<
    RoutineTurnProviderDependencies,
    | "approvalResumeEffectJournal"
    | "clusteringEmbeddings"
    | "embeddingModelForWorkspace"
    | "metricsRegistry"
    | "routineInvocableSkillNames"
    | "routineTriggerEmbeddingService"
  > & {
    composition: Pick<
      ApplicationComposition,
      "capabilityPolicy" | "publishedRoutineRegistrationSource" | "routineRegistrations" | "skillExecutorRegistry"
    >;
    db: Db;
    agentSkillRepository: Pick<AgentSkillRepository, "findByAgentAndName" | "listByAgent">;
    logger: AppLogger;
    routineDefinitionRepository: RoutineDefinitionRepository;
  },
): ChatRoutineProvider => {
  const publishedRoutineSource = input.composition.publishedRoutineRegistrationSource ??
    createPublishedRoutineRegistrationSource(input.routineDefinitionRepository, {
      revisionReader: new AgentRevisionRuntimeRepository(input.db),
      onDefinitionError: ({ agentId, definitionId, error }) => {
        input.logger.warn(
          {
            agentId,
            definitionId,
            err: error,
          },
          "Published routine definition failed to compile; skipping",
        );
      },
      onPinnedDefinitionError: ({ agentId, routineId, definitionId, error }) => {
        input.logger.warn(
          {
            agentId,
            routineId,
            definitionId,
            err: error,
          },
          "Pinned routine definition failed to load or compile; skipping resume-only registration",
        );
      },
      onPreviewDefinitionError: ({ agentId, routineId, error }) => {
        input.logger.warn(
          {
            agentId,
            routineId,
            err: error,
          },
          "Preview (draft) routine definition failed to load or compile; workbench draft test will not run it",
        );
      },
      resolveCompletionExport: async (definition) => {
        const skill = await input.agentSkillRepository.findByAgentAndName(definition.agentId, "completion_export");
        if (!skill) {
          return null;
        }
        if (skill.kind !== "webhook" || !skill.enabled || !skill.targetId) {
          return { enabled: false, triggerKinds: [], destinationRef: "" };
        }
        return {
          enabled: true,
          triggerKinds: definition.completionExport?.triggerKinds?.length
            ? definition.completionExport.triggerKinds
            : ["complete", "handoff"],
          destinationRef: skill.targetId,
        };
      },
    });
  return createRoutineTurnProvider({
    agentSkillRepository: input.agentSkillRepository,
    capabilityPolicy: input.composition.capabilityPolicy,
    clusteringEmbeddings: input.clusteringEmbeddings,
    embeddingModelForWorkspace: input.embeddingModelForWorkspace,
    logger: input.logger,
    metricsRegistry: input.metricsRegistry,
    publishedRoutineSource,
    routineDefinitionRepository: input.routineDefinitionRepository,
    routineInvocableSkillNames: input.routineInvocableSkillNames,
    routineRegistrations: input.composition.routineRegistrations,
    routineTriggerEmbeddingService: input.routineTriggerEmbeddingService,
    skillExecutorRegistry: input.composition.skillExecutorRegistry,
    approvalResumeEffectJournal: input.approvalResumeEffectJournal,
    consentStore: new RoutineConsentRepository(input.db),
    turnPlanAdapters: {
      activator: ({ handle, registry, fallback }) =>
        planAwareRoutineActivator({
          handle: handle as ChatTurnPlanHandle,
          registry,
          fallback,
        }),
      slotCorrection: ({ handle, fallback }) =>
        planAwareRoutineSlotCorrection({
          handle: handle as ChatTurnPlanHandle,
          fallback,
        }),
      reentryGate: ({ handle, fallback }) =>
        planAwareRoutineReentryGate({
          handle: handle as ChatTurnPlanHandle,
          fallback,
        }),
    },
  });
};
