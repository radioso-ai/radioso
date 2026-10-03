import type { RoutineEndingNotificationSubject } from "../../../operatorNotifications/public.js";
import type { RoutineEndingNotificationSubjectResolver } from "./routineEndingNotifyActionHandler.js";

/** Narrow agent lookup for the notice's display name (an `AgentRepository` satisfies it). */
interface RoutineEndingNotificationAgentLookup {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ name: string } | null>;
}

/**
 * Narrow routine lookup for the notice's display name and declared slot order (a
 * `RoutineDefinitionRepository` satisfies it; it returns slots in declaration order).
 */
interface RoutineEndingNotificationRoutineLookup {
  findById(agentId: string, id: string): Promise<{ name: string; slots: ReadonlyArray<{ key: string }> } | null>;
}

/**
 * Narrow conversation lookup for the notice's trusted agent and context lines (a
 * `ConversationRepository` satisfies it).
 */
interface RoutineEndingNotificationConversationLookup {
  findByIdAndWorkspaceId(
    conversationId: string,
    workspaceId: string,
  ): Promise<{ agentId: string | null; entryPageUrl: string | null } | null>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Looks the conversation up by the queued row's ids and takes the agent from it, never from the
 * payload; the routine is looked up under that agent. The compiled routine id the runtime reports
 * is the routine definition id, so no translation is needed. The routine's slot order travels with
 * its name: the queued payload's `collected` is jsonb, which does not keep the order the routine
 * declares its slots in.
 */
export class RepositoryRoutineEndingNotificationSubjectResolver implements RoutineEndingNotificationSubjectResolver {
  constructor(
    private readonly agents: RoutineEndingNotificationAgentLookup,
    private readonly routines: RoutineEndingNotificationRoutineLookup,
    private readonly conversations: RoutineEndingNotificationConversationLookup,
  ) {}

  async resolve(input: {
    workspaceId: string;
    routineId: string | null;
    conversationId: string;
  }): Promise<RoutineEndingNotificationSubject> {
    const conversation = await this.conversations.findByIdAndWorkspaceId(input.conversationId, input.workspaceId);
    if (!conversation?.agentId) {
      return {
        agentId: null,
        agentName: null,
        routineName: null,
        ...(conversation ? { conversation: { entryPageUrl: conversation.entryPageUrl } } : {}),
      };
    }
    // The routine id is payload data: one that is not a uuid names no routine, and querying it
    // would fail the delivery on every retry.
    const routineId = input.routineId && uuidPattern.test(input.routineId) ? input.routineId : null;
    const [agent, agentRoutine] = await Promise.all([
      this.agents.findByIdAndWorkspaceId(conversation.agentId, input.workspaceId),
      routineId ? this.routines.findById(conversation.agentId, routineId) : Promise.resolve(null),
    ]);
    // The routine lookup is keyed by agent, so it counts only when that agent is in this workspace.
    const routine = agent ? agentRoutine : null;
    return {
      agentId: agent ? conversation.agentId : null,
      agentName: agent?.name ?? null,
      routineName: routine?.name ?? null,
      ...(routine ? { routineSlotKeys: routine.slots.map((slot) => slot.key) } : {}),
      conversation: { entryPageUrl: conversation.entryPageUrl },
    };
  }
}
