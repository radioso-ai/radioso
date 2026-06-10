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
export interface RoutineRegistration {
  routine: Routine;
  trigger: {
    description: string;
    priority: number;
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

  constructor(
    private readonly registrations: readonly RoutineRegistration[],
    options: RoutineRegistryOptions = { policy: { floor: 0.4, margin: 0.15, maxOptions: 4 } },
  ) {
    this.policy = options.policy;
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_RANKED_ACTIVATION_PROMPT;
  }

  get routines(): Routine[] {
    return this.registrations.map((registration) => registration.routine);
  }

  get isEmpty(): boolean {
    return this.registrations.length === 0;
  }

  activator(modelGateway: ConversationModelGateway): ConversationRoutineActivator {
    return {
      activate: async ({ turn, loopGuardCandidateIds, suppressClarificationAsk }: {
        turn: TurnContext;
        loopGuardCandidateIds?: string[];
        suppressClarificationAsk?: boolean;
      }) => {
        if (this.registrations.length === 0) {
          return null;
        }
        const knownIds = new Set(this.registrations.map((registration) => registration.routine.id));
        const byId = new Map(this.registrations.map((registration) => [registration.routine.id, registration]));
        const { text } = await modelGateway.complete({
          messages: turnMessages(turn),
          systemPrompt: renderPromptTemplate("chat/routine-ranked-activation.md", this.promptTemplate, {
            routines: routinesBlock(this.registrations),
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
            label: registration.routine.id,
            description: registration.trigger.description,
            confidence: match.confidence,
            payload: {
              routineId: registration.routine.id,
              ...(match.variables ? { variables: match.variables } : {}),
            },
          };
        });
        const priorities = Object.fromEntries(
          this.registrations.map((registration) => [registration.routine.id, registration.trigger.priority]),
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
        const payload = isRecord(decision.candidate.payload) ? decision.candidate.payload : {};
        const routineId = typeof payload.routineId === "string" ? payload.routineId : decision.candidate.id;
        const variables = isRecord(payload.variables) ? payload.variables : undefined;
        return { kind: "activate", routineId, variables };
      },
    };
  }
}
