/** A teammate who can own a conversation in a workspace, named by their teammate label. */
export interface ConversationOperator {
  userId: string;
  label: string;
}

/**
 * The teammates a conversation can be handed to: active, non-disabled users of the workspace's
 * organisation who hold `workspace.conversation.takeover` on that workspace. Handoff owns the
 * question; the host answers it from account memberships, grants, and the same permission
 * resolution the routes use, so role rules are never restated here.
 */
export interface ConversationOperatorDirectory {
  list(input: { accountId: string; workspaceId: string }): Promise<ConversationOperator[]>;
  find(input: { accountId: string; workspaceId: string; userId: string }): Promise<ConversationOperator | null>;
}
