import type { RoutineRegistration } from "../../modules/chat/composition.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import {
  compileRoutineDefinition,
  legacyCompiledRoutineId,
  type RoutineCompletionExport,
  type RoutineDefinition,
} from "../../modules/routines/public.js";

export interface PublishedRoutineRegistrationSource {
  load(input: { agentId: string }): Promise<RoutineRegistration[]>;
  loadPinned(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
  /**
   * Loads specific definitions by id regardless of lifecycle status (including
   * `draft`), for operator test-runs in the workbench. Never used by the live
   * end-user turn path — the published-only gate (`load`) stays authoritative there.
   */
  loadPreview(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
}

export interface PublishedRoutineRegistrationSourceOptions {
  onDefinitionError?: (input: { agentId: string; definitionId: string; error: unknown }) => void;
  onPinnedDefinitionError?: (input: { agentId: string; routineId: string; definitionId?: string; error: unknown }) => void;
  onPreviewDefinitionError?: (input: { agentId: string; routineId: string; error: unknown }) => void;
  resolveCompletionExport?: (definition: RoutineDefinition) => Promise<RoutineCompletionExport | null>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const registrationFromDefinition = async (
  definition: RoutineDefinition,
  options: PublishedRoutineRegistrationSourceOptions,
): Promise<RoutineRegistration> => {
  const skillBackedCompletionExport = await options.resolveCompletionExport?.(definition);
  const routine = compileRoutineDefinition({
    ...definition,
    ...(skillBackedCompletionExport ? { completionExport: skillBackedCompletionExport } : {}),
  });
  return {
    routine,
    trigger: {
      description: definition.activation.triggerDescription,
      priority: definition.activation.priority,
      reentryMode: definition.activation.reentryMode ?? "once_per_conversation",
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
  repository: Pick<RoutineDefinitionRepository, "listPublishedByAgent" | "listByAgent" | "findPinnedById" | "findById">,
  options: PublishedRoutineRegistrationSourceOptions = {},
): PublishedRoutineRegistrationSource => ({
  async load({ agentId }) {
    const definitions = await repository.listPublishedByAgent(agentId);
    const registrations: RoutineRegistration[] = [];
    for (const definition of definitions) {
      try {
        registrations.push(await registrationFromDefinition(definition, options));
      } catch (error) {
        options.onDefinitionError?.({ agentId, definitionId: definition.id, error });
      }
    }
    return registrations;
  },
  async loadPreview({ agentId, routineIds }) {
    const uniqueRoutineIds = [...new Set(routineIds)].filter((routineId) => routineId.length > 0);
    const registrations: RoutineRegistration[] = [];
    for (const routineId of uniqueRoutineIds) {
      try {
        // findById returns any lifecycle status (drafts included); this is the one
        // path that deliberately bypasses the published-only gate.
        const definition = await repository.findById(agentId, routineId);
        if (!definition) {
          options.onPreviewDefinitionError?.({
            agentId,
            routineId,
            error: new Error(`preview_routine_definition_not_found:${routineId}`),
          });
          continue;
        }
        registrations.push(await registrationFromDefinition(definition, options));
      } catch (error) {
        options.onPreviewDefinitionError?.({ agentId, routineId, error });
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
          registrations.push(await registrationFromDefinition(definition, options));
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
        const registration = await registrationFromDefinition(definition, options);
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
