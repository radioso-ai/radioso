import type {
  ConversationModelGateway,
  ConversationRoutineActivator,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";

/**
 * A registered Routine plus when it should *start*. `activates` is consulted only
 * when no routine is active for the session; returning a (possibly empty) object
 * starts the routine — optionally seeding its initial variables — and null declines.
 * Activation logic (an explicit intent click, an LLM intent check, etc.) lives in the
 * registration, not in the engine. The per-turn `modelGateway` lets a registration run
 * an LLM intent check (e.g. natural-language "I want to contact a human").
 */
export interface RoutineRegistration {
  routine: Routine;
  activates(input: {
    turn: TurnContext;
    modelGateway: ConversationModelGateway;
  }): Promise<{ variables?: Record<string, unknown> } | null>;
}

/**
 * Holds the application's registered routines. It hands the runner the full routine
 * set and exposes a {@link ConversationRoutineActivator} that starts the first routine
 * whose registration claims the turn. The engine never names a routine — routines are
 * data registered at composition, like skills.
 */
export class RoutineRegistry {
  constructor(private readonly registrations: readonly RoutineRegistration[]) {}

  get routines(): Routine[] {
    return this.registrations.map((registration) => registration.routine);
  }

  get isEmpty(): boolean {
    return this.registrations.length === 0;
  }

  activator(modelGateway: ConversationModelGateway): ConversationRoutineActivator {
    return {
      activate: async ({ turn }: { turn: TurnContext }) => {
        for (const registration of this.registrations) {
          const decision = await registration.activates({ turn, modelGateway });
          if (decision) {
            return { routineId: registration.routine.id, variables: decision.variables };
          }
        }
        return null;
      },
    };
  }
}
