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
 * Narrow conversation lookup for the notice's context lines (a `ConversationRepository`
 * satisfies it). Only facts the conversation row already stores; the notice adds no storage.
 */
interface RoutineEndingNotificationConversationLookup {
  findByIdAndWorkspaceId(
    conversationId: string,
    workspaceId: string,
  ): Promise<{ sourceChannel: string | null; entryPageUrl: string | null } | null>;
}

/**
 * Looks the agent, routine, and conversation up by the ids the notice payload carries. The
 * compiled routine id the runtime reports is the routine definition id, so no translation is
 * needed. The routine's slot order travels with its name: the queued payload's `collected`
 * is jsonb, which does not keep the order the routine declares its slots in.
 */
export class RepositoryRoutineEndingNotificationSubjectResolver implements RoutineEndingNotificationSubjectResolver {
  constructor(
    private readonly agents: RoutineEndingNotificationAgentLookup,
    private readonly routines: RoutineEndingNotificationRoutineLookup,
    private readonly conversations: RoutineEndingNotificationConversationLookup,
  ) {}

  async resolve(input: {
    workspaceId: string;
    agentId: string;
    routineId: string | null;
    conversationId: string;
  }): Promise<RoutineEndingNotificationSubject> {
    const [agent, routine, conversation] = await Promise.all([
      this.agents.findByIdAndWorkspaceId(input.agentId, input.workspaceId),
      input.routineId ? this.routines.findById(input.agentId, input.routineId) : Promise.resolve(null),
      this.conversations.findByIdAndWorkspaceId(input.conversationId, input.workspaceId),
    ]);
    return {
      agentName: agent?.name ?? null,
      routineName: routine?.name ?? null,
      ...(routine ? { routineSlotKeys: routine.slots.map((slot) => slot.key) } : {}),
      ...(conversation
        ? { conversation: { channel: conversation.sourceChannel, entryPageUrl: conversation.entryPageUrl } }
        : {}),
    };
  }
}
