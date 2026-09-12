import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import type {
  AnswerCoverageCriteria,
  ConversationModelGateway,
  ConversationCoverageRoutineActivator,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineRunner,
  ConversationRoutineSlotCorrection,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  RoutineRegistry,
  RoutineNextStepSelector,
  RoutineReentryGate,
  RoutineSlotCorrector,
  RoutineStepRenderer,
  type RoutineGroundedAnswerRenderer,
  type RoutineRegistration,
} from "@radioso/conversation-defaults";

import type { AgentSkillRepositoryPort } from "../agentSkills/public.js";
import type { ClusteringEmbeddingPort } from "../embeddingProfiles/contracts/embeddingConsumers.js";
import type { CapabilityPolicy } from "../../shared/domain/capabilityPolicy.js";
import { registeredCapabilityNames } from "../../shared/domain/capabilityPolicy.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { RoutineInvocableSkillNames, SkillExecutorRegistry } from "../skills/public.js";
import { RoutineSkillExecutorDispatcher } from "./skillDispatcher.js";
import type { TurnExecutionMode } from "../../shared/domain/turnExecutionMode.js";
import { createRoutineSkillResolverChain } from "./routineSkillResolverChain.js";
import type { RoutineTriggerEmbeddingService } from "./routineTriggerEmbeddingService.js";
import { createRoutineActivationPrefilter } from "./routineActivationPrefilter.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";

interface RoutineRegistrationSource {
  load(input: { agentId: string; workspaceId?: string; agentRevisionId?: string }): Promise<RoutineRegistration[]>;
  loadPinned(input: { agentId: string; workspaceId?: string; agentRevisionId?: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
  loadPreview(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
}

interface RoutineTurnPlanAdapters {
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

interface RoutineTurnProviderDependencies {
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

interface RoutineTurnProvider {
  forTurn(input: {
    modelGateway: ConversationModelGateway;
    agentId: string;
    agentRevisionId?: string;
    workspaceId?: string;
    accountId?: string;
    pinnedRoutineIds?: string[];
    previewRoutineIds?: string[];
    responseLanguage?: string | Promise<string | undefined>;
    groundedAnswerRenderer?: RoutineGroundedAnswerRenderer;
    throwIfCancelled?: () => void;
    turnPlan?: unknown;
    executionMode?: TurnExecutionMode;
  }): Promise<{
    routines?: readonly Routine[];
    activator: ConversationRoutineActivator;
    /** Runs only after the engine has attached an assessed coverage signal. */
    coverageActivator?: ConversationCoverageRoutineActivator;
    runner: ConversationRoutineRunner;
    slotCorrection?: ConversationRoutineSlotCorrection;
    reentryGate?: ConversationRoutineReentryGate;
  } | null>;
}

const routineActivationPolicy = { floor: 0.4, margin: 0.15, askMargin: 0.15, maxOptions: 4 };

const coverageCriteriaMatches = (criteria: AnswerCoverageCriteria, turn: TurnContext): boolean => {
  const assessment = turn.metadata?.answerCoverage;
  if (!assessment || typeof assessment !== "object" || !("availability" in assessment)) {
    return false;
  }
  if (assessment.availability !== "assessed" || !("coverage" in assessment) || !("reason" in assessment)) {
    return false;
  }
  const coverage = assessment.coverage;
  const reason = assessment.reason;
  return typeof coverage === "string"
    && typeof reason === "string"
    && criteria.coverage.includes(coverage as AnswerCoverageCriteria["coverage"][number])
    && (criteria.reasons === undefined || criteria.reasons.includes(reason as NonNullable<AnswerCoverageCriteria["reasons"]>[number]));
};

export const createRoutineTurnProvider = (
  dependencies: RoutineTurnProviderDependencies,
): RoutineTurnProvider => ({
  async forTurn({
    modelGateway,
    agentId,
    agentRevisionId,
    workspaceId,
    accountId,
    pinnedRoutineIds = [],
    previewRoutineIds = [],
    responseLanguage,
    groundedAnswerRenderer,
    throwIfCancelled,
    turnPlan,
    executionMode = "live",
  }) {
    let publishedRegistrations: RoutineRegistration[];
    try {
      publishedRegistrations = await dependencies.publishedRoutineSource.load({ agentId, workspaceId, agentRevisionId });
    } catch (error) {
      if (agentRevisionId) throw error;
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
        workspaceId,
        agentRevisionId,
        routineIds: pinnedRoutineIds,
      });
    } catch (error) {
      if (agentRevisionId) throw error;
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

    const activationPrefilter = workspaceId
      ? createRoutineActivationPrefilter({
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
        })
      : undefined;
    const routineRegistryOptions = {
      policy: routineActivationPolicy,
      promptTemplate: loadPromptTemplate("chat/routine-ranked-activation.md"),
      ...(activationPrefilter ? { activationPrefilter } : {}),
    };
    // Coverage-gated candidates are already narrowed to a structural, coverage-
    // criteria match before this ranking step runs. The legacy ranked-activation
    // prompt asks whether the user's message "wants to start" a routine, which a
    // state-triggered fallback (its trigger describes a coverage gap, not a
    // topic) can never satisfy in its own words, so this path uses a differently
    // framed prompt. The embedding prefilter is deliberately omitted here too: it
    // scores cosine similarity between the user's message and the routine's
    // trigger description, which is a meaningful topic signal for legacy,
    // intent-phrased triggers but not for a coverage-gated trigger, which
    // describes a system state ("no answer found"), not a topic. No wording of
    // that trigger can make it embed close to an arbitrary unanswered question,
    // so running it through the same prefilter only produces false negatives.
    const coverageRoutineRegistryOptions = {
      policy: routineActivationPolicy,
      promptTemplate: loadPromptTemplate("chat/routine-coverage-ranked-activation.md"),
    };
    // Pinned and preview definitions replace the same routine ID for every
    // runtime path. Partition only after this precedence is resolved, otherwise
    // a coverage rule from an older version can leak into pre-evidence reentry.
    const effectiveRegistrationsById = new Map(
      gatedRegistrations.map((registration) => [registration.routine.id, registration] as const),
    );
    for (const registration of pinnedRegistrations) {
      effectiveRegistrationsById.set(registration.routine.id, registration);
    }
    for (const registration of previewRegistrations) {
      effectiveRegistrationsById.set(registration.routine.id, registration);
    }
    const effectiveRegistrations = [...effectiveRegistrationsById.values()];
    // A coverage-gated routine is deliberately absent from the historical
    // pre-retrieval registry. Its activation decision is made only after the
    // engine attaches the assessed signal to a turn with admitted evidence.
    const legacyRegistrations = effectiveRegistrations.filter(
      (registration) => registration.routine.activation?.coverageCriteria === undefined,
    );
    const coverageRegistrations = effectiveRegistrations.filter(
      (registration) => registration.routine.activation?.coverageCriteria !== undefined,
    );
    const routineRegistry = new RoutineRegistry(legacyRegistrations, routineRegistryOptions);
    const routines = effectiveRegistrations.map((registration) => registration.routine);
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
    let notifySkills: Array<{ skillName: string; enabled: boolean; invocationMode: string }> = [];
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
        // One read serves both retrieve and notify: each applies its own
        // enabled && routine_named filter (matching the authoring catalog),
        // so both can be derived from the same agent-skill spine.
        const agentSkills = await dependencies.agentSkillRepository.listByAgent(workspaceId, agentId);
        retrieveSkills = agentSkills
          .filter((skill) => skill.kind === "retrieve")
          .map((skill) => ({
            skillName: skill.skillName,
            enabled: skill.enabled,
            invocationMode: skill.invocationMode,
            config: skill.config,
          }));
        notifySkills = agentSkills
          .filter((skill) => skill.kind === "notify")
          .map((skill) => ({
            skillName: skill.skillName,
            enabled: skill.enabled,
            invocationMode: skill.invocationMode,
          }));
      }
    } catch (error) {
      dependencies.logger.warn(
        { agentId, err: error instanceof Error ? error.message : String(error) },
        "Retrieve and notify skill definitions failed to load for routine routing; continuing without them",
      );
    }

    const reentryGate = dependencies.turnPlanAdapters.reentryGate({
      handle: turnPlan,
      fallback: new RoutineReentryGate(routines, modelGateway, {
        promptTemplate: loadPromptTemplate("chat/routine-reentry-gate.md"),
      }),
    });
    const legacyRoutineIds = new Set(legacyRegistrations.map((registration) => registration.routine.id));
    const preEvidenceReentryGate: ConversationRoutineReentryGate = {
      decide: (reentryInput) => legacyRoutineIds.has(reentryInput.completedState.routineId)
        ? reentryGate.decide(reentryInput)
        : Promise.resolve({ kind: "suppress" }),
    };
    const coverageReentryGate: ConversationRoutineReentryGate = {
      decide: (reentryInput) => {
        const registration = coverageRegistrations.find(
          (candidate) => candidate.routine.id === reentryInput.completedState.routineId,
        );
        return registration && coverageCriteriaMatches(registration.routine.activation!.coverageCriteria!, reentryInput.turn)
          ? reentryGate.decide(reentryInput)
          : Promise.resolve({ kind: "suppress" });
      },
    };

    return {
      routines,
      activator: routineRegistry.isEmpty
        ? { activate: async () => null }
        : dependencies.turnPlanAdapters.activator({
            handle: turnPlan,
            registry: routineRegistry,
            fallback: routineRegistry.activator(modelGateway),
          }),
      ...(coverageRegistrations.length > 0
        ? {
            coverageActivator: {
              evaluateCandidates: ({ turn, suppressedRoutineIds = [] }) => {
                const suppressed = new Set(suppressedRoutineIds);
                return coverageRegistrations
                  .filter((registration) => coverageCriteriaMatches(registration.routine.activation!.coverageCriteria!, turn))
                  .map((registration) => {
                    const isSuppressed = suppressed.has(registration.routine.id)
                      && registration.routine.activation?.reentryMode !== "always";
                    return {
                      routineId: registration.routine.id,
                      decision: isSuppressed ? "suppressed" as const : "candidate" as const,
                      reasonCode: isSuppressed ? "completed_routine_suppressed" : "coverage_criteria_candidate",
                    };
                  });
              },
              activate: async (activationInput) => {
                const matchedRegistrations = coverageRegistrations.filter((registration) =>
                  coverageCriteriaMatches(registration.routine.activation!.coverageCriteria!, activationInput.turn),
                );
                if (matchedRegistrations.length === 0) {
                  return null;
                }
                return new RoutineRegistry(matchedRegistrations, coverageRoutineRegistryOptions)
                  .activator(modelGateway)
                  .activate(activationInput);
              },
              reentryGate: coverageReentryGate,
            },
          }
        : {}),
      slotCorrection: dependencies.turnPlanAdapters.slotCorrection({
        handle: turnPlan,
        fallback: new RoutineSlotCorrector(routines, modelGateway, {
          detectPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-detect.md"),
          confirmPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-confirm.md"),
          invalidPromptTemplate: loadPromptTemplate("chat/routine-slot-correction-invalid.md"),
        }),
      }),
      reentryGate: preEvidenceReentryGate,
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
          createRoutineSkillResolverChain({
            webhookSkillNames,
            emailSkillNames,
            slackSkillNames,
            retrieveSkills,
            notifySkills,
          }),
          dependencies.skillExecutorRegistry,
          {
            workspaceId,
            ...(accountId ? { accountId } : {}),
            capabilityGate: (capability) => dependencies.capabilityPolicy.can({ capability, workspaceId }),
            metricsRegistry: dependencies.metricsRegistry ?? null,
            throwIfCancelled,
            executionMode,
          },
        ),
      ),
    };
  },
});
