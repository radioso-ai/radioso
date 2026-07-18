import type {
  ClarificationCandidate,
  ClarificationPolicy,
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineActivator,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";
import { decideClarification } from "@radioso/conversation-engine";

import { renderPromptTemplate } from "./promptTemplate.js";

/**
 * A registered Routine plus declarative trigger metadata for ranked activation.
 */
/**
 * Reentry policy for a completed routine instance within a conversation.
 * - `once_per_conversation` (default): a completed instance suppresses future
 *   activation in the same conversation.
 * - `always`: a completed instance never suppresses; the trigger may fire again.
 * - `semantic`: an LLM gate decides; not yet implemented at activation time, so it
 *   is treated as `once_per_conversation` (the safe default) until that slice lands.
 */
export type RoutineReentryMode = "once_per_conversation" | "always" | "semantic";

export interface RoutineActivationTrigger {
  routineId: string;
  description: string;
}

export interface RoutineActivationPrefilterScore {
  routineId: string;
  score: number;
}

export interface RoutineActivationPrefilter {
  minScore?: number;
  topK?: number;
  rank(input: {
    query: string;
    triggers: readonly RoutineActivationTrigger[];
    turn: TurnContext;
  }): Promise<readonly RoutineActivationPrefilterScore[]>;
}

export interface RoutineRegistration {
  routine: Routine;
  trigger: {
    description: string;
    priority: number;
    gateRef?: string;
    /** Defaults to `once_per_conversation` when omitted. */
    reentryMode?: RoutineReentryMode;
    eligible?: (input: { turn: TurnContext }) => boolean;
    explicitClaim?: (input: { turn: TurnContext }) => { variables?: Record<string, unknown> } | null;
  };
}

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

interface RankedRoutineMatch {
  routineId: string;
  confidence: number;
  variables?: Record<string, unknown>;
}

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

  activator(modelGateway: ConversationModelGateway): ConversationRoutineActivator {
    return {
      activate: async ({ turn, loopGuardCandidateIds, suppressedRoutineIds, suppressClarificationAsk }: {
        turn: TurnContext;
        loopGuardCandidateIds?: string[];
        suppressedRoutineIds?: string[];
        suppressClarificationAsk?: boolean;
      }) => {
        // `suppressedRoutineIds` are the routines that already completed this
        // conversation. Whether a completed routine actually stays suppressed is the
        // routine's reentry policy: `always` reopens to re-activation, every other mode
        // (incl. the default and the not-yet-implemented `semantic`) stays suppressed.
        const suppressed = new Set(suppressedRoutineIds ?? []);
        const eligibleRegistrations = this.registrations.filter((registration) =>
          (!suppressed.has(registration.routine.id) || registration.trigger.reentryMode === "always") &&
          (registration.trigger.eligible?.({ turn }) ?? true)
        );
        if (eligibleRegistrations.length === 0) {
          return null;
        }
        for (const registration of eligibleRegistrations) {
          const claim = registration.trigger.explicitClaim?.({ turn });
          if (claim) {
            return {
              kind: "activate",
              routineId: registration.routine.id,
              variables: claim.variables,
            };
          }
        }
        const rankedRegistrations = await filterRegistrationsByPrefilter(
          eligibleRegistrations,
          turn,
          this.activationPrefilter,
        );
        if (rankedRegistrations.length === 0) {
          return null;
        }
        const knownIds = new Set(rankedRegistrations.map((registration) => registration.routine.id));
        const byId = new Map(rankedRegistrations.map((registration) => [registration.routine.id, registration]));
        const { text } = await modelGateway.complete({
          messages: turnMessages(turn),
          systemPrompt: renderPromptTemplate("chat/routine-ranked-activation.md", this.promptTemplate, {
            routines: routinesBlock(rankedRegistrations),
            latestMessage: turn.inputEvent.content,
          }),
          metadata: {
            routineActivation: true,
            agentId: turn.agent.id,
          },
        });
        const matches = parseRankedMatches(text, knownIds);
        if (!matches) {
          return null;
        }
        const candidates: ClarificationCandidate[] = matches.map((match) => {
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
          rankedRegistrations.map((registration) => [registration.routine.id, registration.trigger.priority]),
        );
        const decision = decideClarification(candidates, this.policy, {
          priorities,
          loopGuardCandidateIds,
          suppressAsk: suppressClarificationAsk,
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
          const activation = (await conversationRoutineActivatorFromCandidate(decision.candidate)?.activate({ turn }))
            ?? { kind: "activate" as const, routineId: decision.candidate.id, variables: undefined };
          return {
            ...activation,
            decisionMetadata: {
              consideredCandidates: candidates,
              decision,
            },
          };
        }
        const activation = (await conversationRoutineActivatorFromCandidate(decision.candidate)?.activate({ turn }))
          ?? { kind: "activate" as const, routineId: decision.candidate.id, variables: undefined };
        return {
          ...activation,
          decisionMetadata: {
            consideredCandidates: candidates,
            decision,
            reason: decision.reason,
          },
        };
      },
    };
  }
}
