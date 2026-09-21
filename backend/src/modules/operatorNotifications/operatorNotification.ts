export type ApprovalOperatorNotification = {
  kind: "approval";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  handle: string;
};

/** A value a handoff notice can print as-is; richer slot values are dropped before delivery. */
export type HandoffCollectedValue = string | number | boolean;

export type HandoffOperatorNotification = {
  kind: "handoff";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  reason: string;
  /** Display name of the agent when it still exists; `null` when it cannot be resolved. */
  agentName?: string | null;
  /** The routine whose handoff terminal raised the notice; absent for a retrieval-miss handoff. */
  routine?: { id: string; name: string | null };
  /** The routine's declared slot values keyed by slot key, in the order the routine declares them. */
  collected?: Record<string, HandoffCollectedValue>;
};

export type OperatorNotification = ApprovalOperatorNotification | HandoffOperatorNotification;

export interface OperatorNotificationContext {
  requestId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  idempotencyKey?: string | null;
  attempt?: number;
}

export interface OperatorNotificationSink {
  deliver(notification: OperatorNotification, context: OperatorNotificationContext): Promise<void>;
}
