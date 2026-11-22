/**
 * Which of an agent's versions has a context variable enabled: its draft, the release customers
 * talk to, or both. A variable's definition is workspace-level and read live, so a change to it
 * reaches every one of these at once.
 */
interface AgentContextVariableUser {
  readonly agentId: string;
  readonly agentName: string;
  readonly uses: "draft" | "published" | "both";
}

/** The agents of a workspace whose draft or published release enables a variable, read from their snapshots. */
export interface AgentContextVariableUsersReader {
  /** At most `limit` agents, by name; `truncated` when more use it. */
  listContextVariableUsers(input: { workspaceId: string; variableId: string; limit: number }): Promise<{
    users: AgentContextVariableUser[];
    truncated: boolean;
  }>;
}
