import type { RoutineRegistration } from "../../modules/chat/composition.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../modules/routines/public.js";

export interface PublishedRoutineRegistrationSource {
  load(input: { agentId: string }): Promise<RoutineRegistration[]>;
  loadPinned(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
}

export interface PublishedRoutineRegistrationSourceOptions {
  onDefinitionError?: (input: { agentId: string; definitionId: string; error: unknown }) => void;
  onPinnedDefinitionError?: (input: { agentId: string; routineId: string; definitionId?: string; error: unknown }) => void;
}

const registrationFromDefinition = (definition: RoutineDefinition): RoutineRegistration => {
  const routine = compileRoutineDefinition(definition);
  return {
    routine,
    trigger: {
      description: definition.activation.triggerDescription,
      priority: definition.activation.priority,
      ...(definition.activation.gateRef ? { gateRef: definition.activation.gateRef } : {}),
    },
  };
};

export const createPublishedRoutineRegistrationSource = (
  repository: Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent" | "findByIdAnyStatus">,
  options: PublishedRoutineRegistrationSourceOptions = {},
): PublishedRoutineRegistrationSource => ({
  async load({ agentId }) {
    const definitions = await repository.listPublishedByAgent(agentId);
    const registrations: RoutineRegistration[] = [];
    for (const definition of definitions) {
      try {
        registrations.push(registrationFromDefinition(definition));
      } catch (error) {
        options.onDefinitionError?.({ agentId, definitionId: definition.id, error });
      }
    }
    return registrations;
  },
  async loadPinned({ agentId, routineIds }) {
    const uniqueRoutineIds = [...new Set(routineIds)].filter((routineId) => routineId.length > 0);
    if (uniqueRoutineIds.length === 0) {
      return [];
    }

    const allDefinitions = await repository.listByAgent(agentId);
    const byCompiledId = new Map<string, RoutineDefinition>();
    for (const definition of allDefinitions) {
      try {
        byCompiledId.set(compileRoutineDefinition(definition).id, definition);
      } catch (error) {
        options.onPinnedDefinitionError?.({ agentId, routineId: "", definitionId: definition.id, error });
      }
    }

    const registrations: RoutineRegistration[] = [];
    for (const routineId of uniqueRoutineIds) {
      let definition = byCompiledId.get(routineId) ?? null;
      if (!definition) {
        definition = await repository.findByIdAnyStatus(agentId, routineId);
      }
      if (!definition) {
        options.onPinnedDefinitionError?.({
          agentId,
          routineId,
          error: new Error(`pinned_routine_definition_not_found:${routineId}`),
        });
        continue;
      }
      try {
        const registration = registrationFromDefinition(definition);
        if (registration.routine.id === routineId || definition.id === routineId) {
          registrations.push(registration);
        }
      } catch (error) {
        options.onPinnedDefinitionError?.({ agentId, routineId, definitionId: definition.id, error });
      }
    }
    return registrations;
  },
});
