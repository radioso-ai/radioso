import type { RoutineRegistration } from "../../modules/chat/composition.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import { compileRoutineDefinition } from "../../modules/routines/public.js";

export interface PublishedRoutineRegistrationSource {
  load(input: { agentId: string }): Promise<RoutineRegistration[]>;
}

export interface PublishedRoutineRegistrationSourceOptions {
  onDefinitionError?: (input: { agentId: string; definitionId: string; error: unknown }) => void;
}

export const createPublishedRoutineRegistrationSource = (
  repository: Pick<RoutineDefinitionRepository, "listPublishedByAgent">,
  options: PublishedRoutineRegistrationSourceOptions = {},
): PublishedRoutineRegistrationSource => ({
  async load({ agentId }) {
    const definitions = await repository.listPublishedByAgent(agentId);
    const registrations: RoutineRegistration[] = [];
    for (const definition of definitions) {
      try {
        const routine = compileRoutineDefinition(definition);
        registrations.push({
          routine,
          trigger: {
            description: definition.activation.triggerDescription,
            priority: definition.activation.priority,
            ...(definition.activation.gateRef ? { gateRef: definition.activation.gateRef } : {}),
          },
        });
      } catch (error) {
        options.onDefinitionError?.({ agentId, definitionId: definition.id, error });
      }
    }
    return registrations;
  },
});
