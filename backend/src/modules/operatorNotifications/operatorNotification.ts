export type ApprovalOperatorNotification = {
  kind: "approval";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  handle: string;
  dashboardPath: string;
};

export type HandoffOperatorNotification = {
  kind: "handoff";
  workspaceId: string;
  conversationId: string;
  agentId: string;
  reason: string;
  dashboardPath: string;
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
