export interface ModelCallUsageContext {
  accountId?: string | null;
  workspaceId: string;
  conversationId?: string | null;
  messageId?: string | null;
  requestId?: string | null;
  surface: string;
  operation: string;
  attemptKey: string;
}

export type ModelCallUsageAttribution = Pick<ModelCallUsageContext, "surface" | "requestId">;
