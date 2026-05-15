import type { ActivitySummary, ActivityTrace } from "../../retrieval/public.js";

export interface ContactHistorySummary {
  id: string;
  sortAt: string;
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  userEmail: string;
  messagePreview: string;
  triggerSource: string;
  triggerReason: string | null;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  activitySummary?: ActivitySummary;
}

export interface ContactHistoryDetail extends ContactHistorySummary {
  message: string;
  finalDeliveryError: string | null;
  activityTrace?: ActivityTrace;
}

export interface ContactHistoryPage {
  contacts: ContactHistorySummary[];
  total: number;
  nextCursor: null;
  hasMore: boolean;
}

export interface ContactHistoryProviderPort {
  listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number },
  ): Promise<ContactHistoryPage>;
  getById(workspaceId: string, requestId: string): Promise<ContactHistoryDetail | null>;
}

export class NoopContactHistoryProvider implements ContactHistoryProviderPort {
  async listPageByWorkspaceId(): Promise<ContactHistoryPage> {
    return {
      contacts: [],
      total: 0,
      nextCursor: null,
      hasMore: false,
    };
  }

  async getById(): Promise<ContactHistoryDetail | null> {
    return null;
  }
}
