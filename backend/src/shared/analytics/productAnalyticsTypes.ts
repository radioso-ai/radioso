export const productAnalyticsEventNames = [
  "workspace.created",
  "document.ingest_failed",
  "document.ingest_queued",
  "document.processing_completed",
  "document.processing_failed",
  "chat.failed",
  "chat.started",
  "chat.completed",
  "chat.citation_clicked",
  "retrieval_settings.updated",
  "website_embed.loaded",
] as const;

export type ProductAnalyticsEventName = (typeof productAnalyticsEventNames)[number];

export interface ProductAnalyticsEvent {
  eventName: ProductAnalyticsEventName;
  timestamp: string;
  workspaceId?: string;
  accountId?: string;
  actorType?: "operator" | "authenticated_user" | "anonymous_user" | "system";
  subjectType?: "workspace" | "document" | "conversation" | "settings" | "embed_session";
  subjectId?: string;
  properties?: Record<string, unknown>;
  source?: "backend" | "worker" | "frontend" | "embed";
}

export const isProductAnalyticsEventName = (value: string): value is ProductAnalyticsEventName =>
  productAnalyticsEventNames.includes(value as ProductAnalyticsEventName);
