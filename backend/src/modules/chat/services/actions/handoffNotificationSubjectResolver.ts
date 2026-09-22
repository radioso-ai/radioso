import type { HandoffNotificationSubjectResolver } from "./handoffNotifyActionHandler.js";

/** Narrow agent lookup for the notice's display name (an `AgentRepository` satisfies it). */
interface HandoffNotificationAgentLookup {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ name: string } | null>;
}

/** Narrow routine lookup for the notice's display name (a `RoutineDefinitionRepository` satisfies it). */
interface HandoffNotificationRoutineLookup {
  findById(agentId: string, id: string): Promise<{ name: string } | null>;
}

/**
 * Looks the agent and routine up by the ids the handoff payload carries. The compiled routine
 * id the runtime reports is the routine definition id, so no translation is needed.
 */
export class RepositoryHandoffNotificationSubjectResolver implements HandoffNotificationSubjectResolver {
  constructor(
    private readonly agents: HandoffNotificationAgentLookup,
    private readonly routines: HandoffNotificationRoutineLookup,
  ) {}

  async resolve(input: {
    workspaceId: string;
    agentId: string;
    routineId: string | null;
  }): Promise<{ agentName: string | null; routineName: string | null }> {
    const [agent, routine] = await Promise.all([
      this.agents.findByIdAndWorkspaceId(input.agentId, input.workspaceId),
      input.routineId ? this.routines.findById(input.agentId, input.routineId) : Promise.resolve(null),
    ]);
    return { agentName: agent?.name ?? null, routineName: routine?.name ?? null };
  }
}
