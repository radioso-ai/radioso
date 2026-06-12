import type { RoutineRegistration } from "../../modules/chat/composition.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import { compileRoutineDefinition, legacyCompiledRoutineId, type RoutineDefinition } from "../../modules/routines/public.js";

export interface PublishedRoutineRegistrationSource {
  load(input: { agentId: string }): Promise<RoutineRegistration[]>;
  loadPinned(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
}

export interface PublishedRoutineRegistrationSourceOptions {
  onDefinitionError?: (input: { agentId: string; definitionId: string; error: unknown }) => void;
  onPinnedDefinitionError?: (input: { agentId: string; routineId: string; definitionId?: string; error: unknown }) => void;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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
  repository: Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent" | "findPinnedById">,
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

    const registrations: RoutineRegistration[] = [];
    // Legacy pre-unification pins (`routine:<agent>:<name>:v<n>`) need the full
    // non-draft scan below; resolve them lazily and only once per turn.
    let legacyById: Map<string, RoutineDefinition> | null = null;
    const resolveLegacy = async (): Promise<Map<string, RoutineDefinition>> => {
      if (legacyById) {
        return legacyById;
      }
      legacyById = new Map<string, RoutineDefinition>();
      const allDefinitions = await repository.listByAgent(agentId);
      for (const definition of allDefinitions) {
        if (definition.status === "draft") {
          continue;
        }
        const legacyId = legacyCompiledRoutineId(definition);
        const current = legacyById.get(legacyId);
        if (!current || shouldReplacePinnedCandidate(current, definition)) {
          legacyById.set(legacyId, definition);
        }
      }
      return legacyById;
    };

    for (const routineId of uniqueRoutineIds) {
      try {
        if (uuidPattern.test(routineId)) {
          // Pins written after the identity unification: routine_states stores the
          // definition id, which is also the compiled routine id.
          const definition = await repository.findPinnedById(agentId, routineId);
          if (!definition) {
            options.onPinnedDefinitionError?.({
              agentId,
              routineId,
              error: new Error(`pinned_routine_definition_not_found:${routineId}`),
            });
            continue;
          }
          registrations.push(registrationFromDefinition(definition));
          continue;
        }

        // Legacy pin: compile the definition but expose it under the pinned id so
        // the runner's `routine.id === state.routineId` resume lookup still works.
        const definition = (await resolveLegacy()).get(routineId) ?? null;
        if (!definition) {
          options.onPinnedDefinitionError?.({
            agentId,
            routineId,
            error: new Error(`pinned_routine_definition_not_found:${routineId}`),
          });
          continue;
        }
        const registration = registrationFromDefinition(definition);
        registrations.push({
          ...registration,
          routine: { ...registration.routine, id: routineId },
        });
      } catch (error) {
        options.onPinnedDefinitionError?.({ agentId, routineId, error });
      }
    }
    return registrations;
  },
});
