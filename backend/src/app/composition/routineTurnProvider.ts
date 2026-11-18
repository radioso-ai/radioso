import { AgentRevisionRuntimeRepository } from "../../db/repositories/agentRevisionRuntimeRepository.js";
import { RoutineConsentRepository } from "../../db/repositories/routineConsentRepository.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import type { AgentSkillRepository, ConversationSkills } from "../../modules/agentSkills/public.js";
import {
  planAwareRoutineActivator,
  planAwareRoutineReentryGate,
  planAwareRoutineSlotCorrection,
  type ChatRoutineProvider,
} from "../../modules/chat/composition.js";
import { createRoutineTurnProvider, type RoutineCompletionExport, type RoutineDefinition } from "../../modules/routines/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { ApplicationComposition } from "./defaultComposition.js";
import { createPublishedRoutineRegistrationSource, type CompletionExportScope } from "./routineDefinitionSource.js";

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
/**
 * A routine's skill-backed completion export, read from the `completion_export` skill of the
 * release the routine is served from (the agent's live skills when that release recorded none),
 * or from the agent's live skill for a routine served from no release (a preview).
 */
export const createCompletionExportResolver = (
  conversationSkills: Pick<ConversationSkills, "forTurn">,
  live: Pick<AgentSkillRepository, "findByAgentAndName">,
) => async (definition: RoutineDefinition, scope: CompletionExportScope): Promise<RoutineCompletionExport | null> => {
  const releaseSkills = scope.release
    ? await conversationSkills.forTurn({ workspaceId: scope.release.workspaceId, id: definition.agentId, authoredAgentSkills: scope.release.agentSkills })
    : null;
  const skill = releaseSkills
    ? releaseSkills.find((candidate) => candidate.skillName === "completion_export") ?? null
    : await live.findByAgentAndName(definition.agentId, "completion_export");
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
};

export const composeRoutineTurnProvider = (
  input: Pick<
    RoutineTurnProviderDependencies,
    | "approvalResumeEffectJournal"
    | "clusteringEmbeddings"
    | "embeddingModelForWorkspace"
    | "metricsRegistry"
    | "routineTriggerEmbeddingService"
  > & {
    composition: Pick<
      ApplicationComposition,
      "capabilityPolicy" | "publishedRoutineRegistrationSource" | "routineRegistrations" | "skillExecutorRegistry"
    >;
    db: Db;
    agentSkillRepository: Pick<AgentSkillRepository, "findByAgentAndName" | "listByAgent">;
    /** How a routine served from a release reads that release's skills (`buildConversationSkills`). */
    conversationSkills: Pick<ConversationSkills, "forTurn">;
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
      resolveCompletionExport: createCompletionExportResolver(input.conversationSkills, input.agentSkillRepository),
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
