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

const pinnedStatusRank = (definition: RoutineDefinition): number => {
  switch (definition.status) {
    case "published":
      return 3;
    case "superseded":
      return 2;
    case "archived":
      return 1;
    case "draft":
      return 0;
  }
};

const shouldReplacePinnedCandidate = (current: RoutineDefinition, candidate: RoutineDefinition): boolean => {
  const currentStatusRank = pinnedStatusRank(current);
  const candidateStatusRank = pinnedStatusRank(candidate);
  if (candidateStatusRank !== currentStatusRank) {
    return candidateStatusRank > currentStatusRank;
  }
  return candidate.version > current.version;
};

export const createPublishedRoutineRegistrationSource = (
  repository: Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent">,
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
      if (definition.status === "draft") {
        continue;
      }
      try {
        const compiledId = compileRoutineDefinition(definition).id;
        const current = byCompiledId.get(compiledId);
        if (!current || shouldReplacePinnedCandidate(current, definition)) {
          byCompiledId.set(compiledId, definition);
        }
      } catch (error) {
        options.onPinnedDefinitionError?.({ agentId, routineId: "", definitionId: definition.id, error });
      }
    }

    const registrations: RoutineRegistration[] = [];
    for (const routineId of uniqueRoutineIds) {
      const definition = byCompiledId.get(routineId) ?? null;
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
        if (registration.routine.id === routineId) {
          registrations.push(registration);
        }
      } catch (error) {
        options.onPinnedDefinitionError?.({ agentId, routineId, definitionId: definition.id, error });
      }
    }
    return registrations;
  },
});
