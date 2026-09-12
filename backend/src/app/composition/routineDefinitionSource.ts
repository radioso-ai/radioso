import type { RoutineRegistration } from "../../modules/chat/composition.js";
import type { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import type { AgentRevision } from "../../modules/agents/public.js";
import {
  compileRoutineDefinition,
  legacyCompiledRoutineId,
  routineCanActivate,
  type RoutineCompletionExport,
  type RoutineDefinition,
} from "../../modules/routines/public.js";

export interface PublishedRoutineRegistrationSource {
  load(input: { agentId: string; workspaceId?: string; agentRevisionId?: string }): Promise<RoutineRegistration[]>;
  loadPinned(input: { agentId: string; workspaceId?: string; agentRevisionId?: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
  /**
   * Loads specific definitions by id whether or not they are enabled, for operator test-runs in
   * the workbench. Never used by the live end-user turn path — the enabled-only gate (`load`)
   * stays authoritative there.
   */
  loadPreview(input: { agentId: string; routineIds: string[] }): Promise<RoutineRegistration[]>;
}

interface PublishedRoutineRegistrationSourceOptions {
  /** Runtime-only immutable reader. When a revision id is supplied it is mandatory. */
  revisionReader?: Pick<{
    findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null>;
  }, "findRevision">;
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
      ...(definition.activation.gateRef ? { gateRef: definition.activation.gateRef } : {}),
    },
  };
};

export const createPublishedRoutineRegistrationSource = (
  repository: Pick<RoutineDefinitionRepository, "listActiveByAgent" | "listVersionsByAgent" | "findPinnedById" | "findById">,
  options: PublishedRoutineRegistrationSourceOptions = {},
): PublishedRoutineRegistrationSource => ({
  async load({ agentId, workspaceId, agentRevisionId }) {
    if (agentRevisionId) {
      const revision = await loadRuntimeRevision(options, { workspaceId, agentId, agentRevisionId });
      return compileFrozenDefinitions(revision.snapshot.routines, options);
    }
    const definitions = await repository.listActiveByAgent(agentId);
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
        // findById resolves to the routine whether or not it is enabled; this is the one
        // path that deliberately bypasses the enabled-only gate.
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
  async loadPinned({ agentId, workspaceId, agentRevisionId, routineIds }) {
    const uniqueRoutineIds = [...new Set(routineIds)].filter((routineId) => routineId.length > 0);
    if (uniqueRoutineIds.length === 0) {
      return [];
    }

    if (agentRevisionId) {
      const revision = await loadRuntimeRevision(options, { workspaceId, agentId, agentRevisionId });
      return compileFrozenPinnedDefinitions(
        [...revision.snapshot.routines, ...(revision.snapshot.retainedRoutineDefinitions ?? [])],
        uniqueRoutineIds,
        options,
      );
    }

    const registrations: RoutineRegistration[] = [];
    // Legacy pre-unification pins (`routine:<agent>:<name>:v<n>`) need the full version
    // scan below; resolve them lazily and only once per turn.
    let legacyById: Map<string, RoutineDefinition> | null = null;
    const resolveLegacy = async (): Promise<Map<string, RoutineDefinition>> => {
      if (legacyById) {
        return legacyById;
      }
      legacyById = new Map<string, RoutineDefinition>();
      const allDefinitions = await repository.listVersionsByAgent(agentId);
      for (const definition of allDefinitions) {
        const legacyId = legacyCompiledRoutineId(definition);
        // (agent_id, name, version) is unique at the DB layer (routine_definition_agent_id_name_
        // version_key), and legacyId is exactly that triple, so this key can never legitimately
        // repeat within one agent's rows. Guard is first-registered-wins in case that invariant
        // is ever violated, not a real tie-break.
        if (!legacyById.has(legacyId)) {
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

const loadRuntimeRevision = async (
  options: PublishedRoutineRegistrationSourceOptions,
  input: { workspaceId?: string; agentId: string; agentRevisionId: string },
): Promise<AgentRevision> => {
  if (!input.workspaceId) {
    throw new Error("agent_revision_workspace_required");
  }
  if (!options.revisionReader) {
    throw new Error("agent_revision_routine_source_not_configured");
  }
  const revision = await options.revisionReader.findRevision({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    revisionId: input.agentRevisionId,
  });
  if (!revision) {
    throw new Error("agent_revision_unavailable");
  }
  return revision;
};

const compileFrozenDefinitions = async (
  definitions: AgentRevision["snapshot"]["routines"],
  options: PublishedRoutineRegistrationSourceOptions,
): Promise<RoutineRegistration[]> => {
  const registrations: RoutineRegistration[] = [];
  // A released revision carries every authored routine, parked ones included, so a routine an
  // operator took out of service must not activate here. Pinned resume below is deliberately
  // unfiltered: a visitor mid-routine finishes it.
  for (const definition of definitions.filter(routineCanActivate)) {
    registrations.push(await registrationFromDefinition(definition, options));
  }
  return registrations;
};

const compileFrozenPinnedDefinitions = async (
  definitions: AgentRevision["snapshot"]["routines"],
  routineIds: string[],
  options: PublishedRoutineRegistrationSourceOptions,
): Promise<RoutineRegistration[]> => {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const legacyById = new Map<string, RoutineDefinition>();
  for (const definition of definitions) {
    const legacyId = legacyCompiledRoutineId(definition);
    // Same uniqueness guarantee as the live-DB path above: this snapshot's routines all
    // originate from one agent's routine_definition rows, so legacyId cannot repeat.
    if (!legacyById.has(legacyId)) {
      legacyById.set(legacyId, definition);
    }
  }
  const registrations: RoutineRegistration[] = [];
  for (const routineId of routineIds) {
    const definition = uuidPattern.test(routineId)
      ? byId.get(routineId)
      : legacyById.get(routineId);
    if (!definition) {
      throw new Error(`pinned_revision_routine_not_found:${routineId}`);
    }
    const registration = await registrationFromDefinition(definition, options);
    registrations.push(uuidPattern.test(routineId)
      ? registration
      : { ...registration, routine: { ...registration.routine, id: routineId } });
  }
  return registrations;
};
