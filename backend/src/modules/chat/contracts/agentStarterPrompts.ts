export interface AgentStarterPrompt {
  label: string;
}

/**
 * Read-only view of the conversation starters an agent shows before its first
 * turn — the greeting chips the web embed renders. Channels that surface starters
 * outside a conversation (Slack's agent pane) read them here; nothing is started,
 * recorded, reserved, or generated.
 */
export interface AgentStarterPromptReader {
  listStarterPrompts(input: { workspaceId: string; agentId: string }): Promise<AgentStarterPrompt[]>;
}
