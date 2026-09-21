import type {
  ConversationCoverageRoutineActivator,
  ConversationModelGateway,
  ConversationRoutineActivator,
  ConversationRoutineReentryGate,
  ConversationRoutineRunner,
  ConversationRoutineSlotCorrection,
  Routine,
  RoutineGroundedAnswerRenderer,
} from "@radioso/conversation-contract";

import type {
  ConversationDurability,
  SkillEffectPolicy,
  TurnExecutionMode,
} from "../../../shared/domain/turnExecutionMode.js";
import type { ChatTurnPlanHandle } from "../services/turnPlanCoordinator.js";

/**
 * The port the chat turn consults for "which routines are eligible this turn and
 * how one gets admitted". The routines module implements it; chat knows nothing
 * about routine identity, slots, or exposure beyond what comes back here.
 */
export interface ChatRoutineProvider {
  forTurn(input: {
    modelGateway: ConversationModelGateway;
    agentId: string;
    /** Immutable release pinned on the conversation; absent only for fixture/replay paths. */
    agentRevisionId?: string;
    workspaceId?: string;
    accountId?: string;
    pinnedRoutineIds?: string[];
    /**
     * Operator-only workbench test override: routine definition ids (drafts included)
     * to make eligible for this turn, bypassing the published-only gate. Empty/absent
     * for every live end-user turn.
     */
    previewRoutineIds?: string[];
    executionMode?: TurnExecutionMode;
    skillEffects?: SkillEffectPolicy;
    conversationDurability?: ConversationDurability;
    responseLanguage?: string | Promise<string | undefined>;
    groundedAnswerRenderer?: RoutineGroundedAnswerRenderer;
    throwIfCancelled?: () => void;
    turnPlan?: ChatTurnPlanHandle;
  }): Promise<{
    routines?: readonly Routine[];
    activator: ConversationRoutineActivator;
    coverageActivator?: ConversationCoverageRoutineActivator;
    runner: ConversationRoutineRunner;
    slotCorrection?: ConversationRoutineSlotCorrection;
    reentryGate?: ConversationRoutineReentryGate;
  } | null>;
}
