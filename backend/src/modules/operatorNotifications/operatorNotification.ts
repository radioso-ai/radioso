export type ApprovalOperatorNotification = {
  kind: "approval";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  handle: string;
};

/** A value a routine-ending notice can print as-is; richer slot values are dropped before delivery. */
export type HandoffCollectedValue = string | number | boolean;

/**
 * The authored notice text, as `{{slot.<key>}}` templates. An absent text renders the default for
 * the notice's kind.
 */
export type OperatorNoticeTemplate = {
  subject?: string;
  intro?: string;
};

/** Facts already stored about the conversation, shown as context lines; `null` when not stored. */
export type OperatorNoticeConversationFacts = {
  entryPageUrl: string | null;
};

/** What every routine-ending notice carries, whichever ending raised it. */
type RoutineEndingNoticeFields = {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  reason: string;
  /** Display name of the agent when it still exists; `null` when it cannot be resolved. */
  agentName?: string | null;
  /** The routine whose ending raised the notice; absent for a retrieval-miss handoff. */
  routine?: { id: string; name: string | null };
  /** The routine's declared slot values keyed by slot key, in the order the routine declares them. */
  collected?: Record<string, HandoffCollectedValue>;
  notice?: OperatorNoticeTemplate;
  conversation?: OperatorNoticeConversationFacts;
};

/** A conversation went to a person: a routine hand-off ending, or a retrieval miss. */
export type HandoffOperatorNotification = { kind: "handoff" } & RoutineEndingNoticeFields;

/** A routine completed with an operator notice; the agent keeps the conversation. */
export type CompletionOperatorNotification = { kind: "completion" } & RoutineEndingNoticeFields;

export type RoutineEndingOperatorNotification = HandoffOperatorNotification | CompletionOperatorNotification;

export type OperatorNotification = ApprovalOperatorNotification | RoutineEndingOperatorNotification;

export interface OperatorNotificationContext {
  requestId: string;
  workspaceId?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  idempotencyKey?: string | null;
  attempt?: number;
  /**
   * The notify skill a routine ending's notice names to send it. A sink that resolves recipients
   * per skill honours it; a sink with its own destination (Slack) ignores it.
   */
  skillName?: string | null;
}

export interface OperatorNotificationSink {
  deliver(notification: OperatorNotification, context: OperatorNotificationContext): Promise<void>;
}
