import type { QualityContentPlanningPopulationTurn } from "../../quality/contracts/contentPlanningEvidence.js";
import type {
  ContentPlanHistoricalTurnRegistration,
  ContentPlanProjectionBudgetPort,
} from "../contracts/persistence.js";
import {
  inspectHistoricalTurnInteraction,
  interpretHistoricalTurnInteraction,
  type HistoricalInteractionInterpreterPort,
  type HistoricalTurnInteractionResolution,
  type ObservationSourceMessage,
} from "./observationSourceResolver.js";
import { CONTENT_PLAN_HISTORICAL_INTERPRETATION_ESTIMATED_SPEND_MICROS } from "./projectionBudgetService.js";
import {
  NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  type ContentPlanWorkerEventSink,
} from "./contentPlanWorkerObservability.js";

export interface ContentPlanHistoricalTurnSourcePort {
  load(input: {
    workspaceId: string;
    turn: QualityContentPlanningPopulationTurn;
  }): Promise<{
    messages: ObservationSourceMessage[];
    legacyAuditMetadata: unknown;
  }>;
}

export type ContentPlanHistoricalTurnPagePreparation =
  | {
      kind: "ready";
      turns: ContentPlanHistoricalTurnRegistration[];
    }
  | {
      kind: "budget_paused";
      reason: "daily_budget_exhausted";
    };

export interface ContentPlanHistoricalTurnProjectionPort {
  preparePage(input: {
    workspaceId: string;
    generationId: string;
    turns: readonly QualityContentPlanningPopulationTurn[];
    now: Date;
  }): Promise<ContentPlanHistoricalTurnPagePreparation>;
}

interface LoadedTurn {
  turn: QualityContentPlanningPopulationTurn & { userMessageId: string };
  messages: ObservationSourceMessage[];
  initial: HistoricalTurnInteractionResolution;
}

const unresolvedInteraction = () => ({
  role: "unresolved" as const,
  semanticIntents: [] as const,
});

export class ContentPlanHistoricalTurnProjectionService
implements ContentPlanHistoricalTurnProjectionPort {
  constructor(
    private readonly source: ContentPlanHistoricalTurnSourcePort,
    private readonly budget: ContentPlanProjectionBudgetPort,
    private readonly interpreter?: HistoricalInteractionInterpreterPort,
    private readonly observability: ContentPlanWorkerEventSink = NOOP_CONTENT_PLAN_WORKER_OBSERVABILITY,
  ) {}

  async preparePage(input: {
    workspaceId: string;
    generationId: string;
    turns: readonly QualityContentPlanningPopulationTurn[];
    now: Date;
  }): Promise<ContentPlanHistoricalTurnPagePreparation> {
    const loaded: LoadedTurn[] = [];
    for (const turn of input.turns) {
      if (!turn.userMessageId) continue;
      const source = await this.source.load({ workspaceId: input.workspaceId, turn });
      loaded.push({
        turn: { ...turn, userMessageId: turn.userMessageId },
        messages: source.messages,
        initial: inspectHistoricalTurnInteraction({
          sourceUserMessageId: turn.userMessageId,
          messages: source.messages,
          legacyAuditMetadata: source.legacyAuditMetadata,
        }),
      });
    }

    const interpretationCount = this.interpreter
      ? loaded.filter(({ initial }) => initial.status === "requires_interpretation").length
      : 0;
    if (interpretationCount > 0) {
      const reservation = await this.budget.reserve({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        requests: interpretationCount,
        estimatedSpendMicros:
          interpretationCount * CONTENT_PLAN_HISTORICAL_INTERPRETATION_ESTIMATED_SPEND_MICROS,
        now: input.now,
      });
      if (reservation.kind === "budget_paused") {
        return reservation;
      }
    }

    const turns: ContentPlanHistoricalTurnRegistration[] = [];
    for (const item of loaded) {
      let resolution = item.initial;
      if (resolution.status === "skip") continue;
      if (resolution.status === "requires_interpretation" && this.interpreter) {
        const providerStartedAt = Date.now();
        try {
          resolution = await interpretHistoricalTurnInteraction({
            sourceUserMessageId: item.turn.userMessageId,
            workspaceId: input.workspaceId,
            conversationId: item.turn.conversationId,
            messages: item.messages,
            interpreter: this.interpreter,
          });
          this.observability.record({
            stage: "discovery",
            outcome: "completed",
            workspaceId: input.workspaceId,
            generationId: input.generationId,
            durationMs: Math.max(0, Date.now() - providerStartedAt),
            providerOperation: "historical_interpretation",
            providerCallCount: 1,
          });
        } catch {
          this.observability.record({
            stage: "discovery",
            outcome: "terminal_failure",
            reason: "historical_interpretation_failed",
            workspaceId: input.workspaceId,
            generationId: input.generationId,
            durationMs: Math.max(0, Date.now() - providerStartedAt),
            providerOperation: "historical_interpretation",
            providerCallCount: 1,
          });
          resolution = { status: "unavailable", reason: "ambiguous" };
        }
      }
      turns.push({
        conversationId: item.turn.conversationId,
        sourceChannel: item.turn.channel ?? undefined,
        sourceUserMessageId: resolution.status === "resolved"
          ? resolution.sourceUserMessageId
          : item.turn.userMessageId,
        sourceAssistantMessageId: item.turn.assistantMessageId,
        interaction: resolution.status === "resolved"
          ? {
              role: resolution.role,
              semanticIntents: resolution.semanticIntents,
            }
          : unresolvedInteraction(),
      });
    }
    return { kind: "ready", turns };
  }
}
