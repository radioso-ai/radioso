import type {
  ClarificationCandidate,
  ClarificationPolicy,
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineActivator,
  PreparedRoutineCandidates,
  RankableRoutineCandidates,
  RankedRoutineMatch,
  Routine,
  RoutineActivationPrefilter,
  RoutineActivationResult,
  RoutineRegistration,
  TurnContext,
} from "@radioso/conversation-contract";
import { decideClarification } from "@radioso/conversation-engine";

import { renderPromptTemplate } from "./promptTemplate.js";

/**
 * Reentry policy now lives on the compiled routine (`Routine.activation`), which is
 * the single source of truth both this registry and the reentry gate read. Re-exported
 * here so existing importers of this module keep resolving it.
 */
export type { RoutineReentryMode } from "@radioso/conversation-contract";

// Ranked-activation contracts now live in @radioso/conversation-contract so a host planner
// can conform to them without depending on this default registry; re-exported here because
// this module is their primary implementation.
export type {
  PreparedRoutineCandidates,
  RankableRoutineCandidates,
  RankedRoutineMatch,
  RoutineActivationPrefilter,
  RoutineActivationPrefilterScore,
  RoutineActivationResult,
  RoutineActivationTrigger,
  RoutineCandidateSummary,
  RoutineRegistration,
} from "@radioso/conversation-contract";

export const DEFAULT_ROUTINE_RANKED_ACTIVATION_PROMPT = `Rank whether the latest user message wants to start any registered routine.

Return only JSON:
{"matches":[{"routineId":"<id>","confidence":0.0,"variables":{}}]}

Routines:
{{routines}}`;

export interface RoutineRegistryOptions {
  policy: ClarificationPolicy;
  promptTemplate?: string;
  activationPrefilter?: RoutineActivationPrefilter;
}

/** The activate arm of {@link RoutineActivationResult}. */
type RoutineActivateOutcome = Extract<RoutineActivationResult, { kind: "activate" }>;

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const routinesBlock = (registrations: readonly RoutineRegistration[]): string =>
  registrations
    .map((registration, index) =>
      `${index + 1}. id: ${registration.routine.id}\n` +
      `Priority: ${registration.trigger.priority}\n` +
      `Trigger: ${registration.trigger.description}`
    )
    .join("\n\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const routineLabel = (routine: Routine): string => {
  const name = isRecord(routine.metadata) && typeof routine.metadata.name === "string"
    ? routine.metadata.name.trim()
    : "";
  return name || routine.id;
};

const DEFAULT_PREFILTER_TOP_K = 8;
const DEFAULT_PREFILTER_MIN_SCORE = 0.2;

const filterRegistrationsByPrefilter = async (
  registrations: readonly RoutineRegistration[],
  turn: TurnContext,
  prefilter: RoutineActivationPrefilter | undefined,
): Promise<readonly RoutineRegistration[]> => {
  if (!prefilter) {
    return registrations;
  }
  const byId = new Map(registrations.map((registration) => [registration.routine.id, registration]));
  try {
    const ranked = await prefilter.rank({
      query: turn.inputEvent.content,
      triggers: registrations.map((registration) => ({
        routineId: registration.routine.id,
        description: registration.trigger.description,
      })),
      turn,
    });
    const minScore = prefilter.minScore ?? DEFAULT_PREFILTER_MIN_SCORE;
    const topK = Math.max(1, prefilter.topK ?? DEFAULT_PREFILTER_TOP_K);
    const seen = new Set<string>();
    return ranked
      .filter((item) => Number.isFinite(item.score) && item.score >= minScore && byId.has(item.routineId))
      .sort((left, right) => right.score - left.score || left.routineId.localeCompare(right.routineId))
      .filter((item) => {
        if (seen.has(item.routineId)) {
          return false;
        }
        seen.add(item.routineId);
        return true;
      })
      .slice(0, topK)
      .map((item) => byId.get(item.routineId)!);
  } catch {
    return registrations;
  }
};

export const conversationRoutineActivatorFromCandidate = (
  candidate: ClarificationCandidate,
): ConversationRoutineActivator | null => {
  const payload = isRecord(candidate.payload) ? candidate.payload : null;
  if (!payload || typeof payload.routineId !== "string") {
    return null;
  }
  const routineId = payload.routineId;
  const variables = isRecord(payload.variables) ? payload.variables : undefined;
  return {
    async activate() {
      return { kind: "activate", routineId, variables };
    },
  };
};

const parseRankedMatches = (raw: string, knownIds: Set<string>): RankedRoutineMatch[] | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.matches)) {
      return null;
    }
    const matches: RankedRoutineMatch[] = [];
    for (const item of parsed.matches) {
      if (!isRecord(item) || typeof item.routineId !== "string" || !knownIds.has(item.routineId)) {
        return null;
      }
      if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        return null;
      }
      matches.push({
        routineId: item.routineId,
        confidence: item.confidence,
        ...(isRecord(item.variables)
          ? { variables: item.variables }
          : isRecord(item.activationVariables)
            ? { variables: item.activationVariables }
            : {}),
      });
    }
    return matches;
  } catch {
    return null;
  }
};

/**
 * Holds the application's registered routines. It hands the runner the full routine
 * set and exposes a {@link ConversationRoutineActivator} that starts the first routine
 * whose registration claims the turn. The engine never names a routine — routines are
 * data registered at composition, like skills.
 */
export class RoutineRegistry {
  private readonly policy: ClarificationPolicy;
  private readonly promptTemplate: string;
  private readonly activationPrefilter?: RoutineActivationPrefilter;

  constructor(
    private readonly registrations: readonly RoutineRegistration[],
    options: RoutineRegistryOptions = { policy: { floor: 0.4, margin: 0.15, maxOptions: 4 } },
  ) {
    this.policy = options.policy;
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_RANKED_ACTIVATION_PROMPT;
    this.activationPrefilter = options.activationPrefilter;
  }

  get routines(): Routine[] {
    return this.registrations.map((registration) => registration.routine);
  }

  get isEmpty(): boolean {
    return this.registrations.length === 0;
  }

  /**
   * The eligibility pipeline that runs before the ranked-activation call:
   * completed-state suppression (honoring `always` reentry), per-registration
   * eligibility gates, explicit claims (which short-circuit without ranking), and
   * the embedding prefilter with its min-score/top-K bounds. Returns the bounded
   * registrations plus planner-consumable summaries; exposes no activation policy.
   */
  async prepareCandidates(
    turn: TurnContext,
    options: { suppressedRoutineIds?: readonly string[] } = {},
  ): Promise<PreparedRoutineCandidates> {
    // `suppressedRoutineIds` are the routines that already completed this
    // conversation. Whether a completed routine actually stays suppressed is the
    // routine's authored reentry policy: `always` reopens to re-activation, every other
    // mode stays suppressed. `semantic` re-opens the completed *instance* through the
    // reentry gate, which runs before activation, so it never re-enters here. A routine
    // with no authored activation defaults to `once_per_conversation`.
    const suppressed = new Set(options.suppressedRoutineIds ?? []);
    const eligibleRegistrations = this.registrations.filter((registration) =>
      (!suppressed.has(registration.routine.id) || registration.routine.activation?.reentryMode === "always") &&
      (registration.trigger.eligible?.({ turn }) ?? true)
    );
    if (eligibleRegistrations.length === 0) {
      return { kind: "none" };
    }
    for (const registration of eligibleRegistrations) {
      const claim = registration.trigger.explicitClaim?.({ turn });
      if (claim) {
        return {
          kind: "claim",
          activation: {
            kind: "activate",
            routineId: registration.routine.id,
            variables: claim.variables,
          },
        };
      }
    }
    const rankedRegistrations = await filterRegistrationsByPrefilter(
      eligibleRegistrations,
      turn,
      this.activationPrefilter,
    );
    if (rankedRegistrations.length === 0) {
      return { kind: "none" };
    }
    return {
      kind: "rank",
      registrations: rankedRegistrations,
      candidates: rankedRegistrations.map((registration) => ({
        routineId: registration.routine.id,
        title: routineLabel(registration.routine),
        triggerSummary: registration.trigger.description,
        priority: registration.trigger.priority,
      })),
    };
  }

  /**
   * The post-rank policy: map ranked matches to clarification candidates, apply the
   * registry's clarification policy (floor / margin / priority tie-breaks), and
   * produce the activate/clarify/decline outcome with the same `consideredCandidates`
   * payload the activator produces today. Runs identically on the legacy
   * ranked-activation call's output or a planner's precomputed scores.
   */
  async applyRankedDecision(
    prepared: RankableRoutineCandidates,
    rankings: readonly RankedRoutineMatch[],
    options: {
      turn: TurnContext;
      loopGuardCandidateIds?: string[];
      suppressClarificationAsk?: boolean;
    },
  ): Promise<RoutineActivationResult | null> {
    const byId = new Map(prepared.registrations.map((registration) => [registration.routine.id, registration]));
    const candidates: ClarificationCandidate[] = rankings.map((match) => {
      const registration = byId.get(match.routineId)!;
      return {
        id: registration.routine.id,
        label: routineLabel(registration.routine),
        description: registration.trigger.description,
        confidence: match.confidence,
        payload: {
          routineId: registration.routine.id,
          ...(match.variables ? { variables: match.variables } : {}),
        },
      };
    });
    const priorities = Object.fromEntries(
      prepared.registrations.map((registration) => [registration.routine.id, registration.trigger.priority]),
    );
    const decision = decideClarification(candidates, this.policy, {
      priorities,
      loopGuardCandidateIds: options.loopGuardCandidateIds,
      suppressAsk: options.suppressClarificationAsk,
    });
    if (decision.kind === "none") {
      return null;
    }
    if (decision.kind === "ask") {
      return { kind: "clarify", candidates: decision.candidates };
    }
    if (decision.kind === "soft_pick") {
      // Slice 4 implements offer behavior; band is empty in slice 3 so this
      // is unreachable at runtime.
      const activation = await this.pickActivation(decision.candidate, options.turn);
      return {
        ...activation,
        decisionMetadata: {
          consideredCandidates: candidates,
          decision,
        },
      };
    }
    const activation = await this.pickActivation(decision.candidate, options.turn);
    return {
      ...activation,
      decisionMetadata: {
        consideredCandidates: candidates,
        decision,
        reason: decision.reason,
      },
    };
  }

  /**
   * Resolve a chosen clarification candidate into its activation. The candidate
   * activator only ever yields an activate outcome (never clarify), so the result
   * carries the `routineId`/`variables` the decision metadata is spread onto.
   */
  private async pickActivation(
    candidate: ClarificationCandidate,
    turn: TurnContext,
  ): Promise<RoutineActivateOutcome> {
    const picked = await conversationRoutineActivatorFromCandidate(candidate)?.activate({ turn });
    if (picked && picked.kind === "activate") {
      return picked;
    }
    return { kind: "activate", routineId: candidate.id, variables: undefined };
  }

  activator(modelGateway: ConversationModelGateway): ConversationRoutineActivator {
    return {
      activate: async ({ turn, loopGuardCandidateIds, suppressedRoutineIds, suppressClarificationAsk }: {
        turn: TurnContext;
        loopGuardCandidateIds?: string[];
        suppressedRoutineIds?: string[];
        suppressClarificationAsk?: boolean;
      }) => {
        const prepared = await this.prepareCandidates(turn, { suppressedRoutineIds });
        if (prepared.kind === "claim") {
          return prepared.activation;
        }
        if (prepared.kind === "none") {
          return null;
        }
        const knownIds = new Set(prepared.registrations.map((registration) => registration.routine.id));
        const { text } = await modelGateway.complete({
          messages: turnMessages(turn),
          systemPrompt: renderPromptTemplate("chat/routine-ranked-activation.md", this.promptTemplate, {
            routines: routinesBlock(prepared.registrations),
            latestMessage: turn.inputEvent.content,
          }),
          metadata: {
            routineActivation: true,
            agentId: turn.agent.id,
          },
        });
        const rankings = parseRankedMatches(text, knownIds);
        if (!rankings) {
          return null;
        }
        return this.applyRankedDecision(prepared, rankings, {
          turn,
          loopGuardCandidateIds,
          suppressClarificationAsk,
        });
      },
    };
  }
}
