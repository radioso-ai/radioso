import type { ChatStreamEvent } from "../services/chatService.js";
import type { ChatResponse } from "./chatResponses.js";

export type AssistantRouteType = "direct" | "retrieval";
export type AssistantRouteReason =
  | "assistant_identity"
  | "conversation_start"
  | "evidence_required"
  | "social_only";

export interface AssistantRoute {
  type: AssistantRouteType;
  reason: AssistantRouteReason;
}

export interface AssistantRouteDiagnostics {
  generator: string;
  routeType: AssistantRouteType;
  routeReason: AssistantRouteReason;
  retrievalInvoked: boolean;
}

export interface AssistantSourceContext {
  surface?: "authenticated_chat" | "public_chat" | "website_embed";
  sourceOrigin?: string | null;
}

export interface AssistantPageContext {
  pageUrl?: string | null;
  pageTitle?: string | null;
  pageLocale?: string | null;
  browserLocale?: string | null;
  content?: string | null;
}

export interface AssistantChatRequest {
  workspaceId: string;
  accountId?: string;
  conversationId?: string;
  message?: string;
  startConversation?: boolean;
  stream: boolean;
  userExpectedLocale?: string | null;
  inputMetadata?: import("../../../db/repositories/messageRepository.js").UserMessageInputMetadata;
  sourceContext?: AssistantSourceContext;
  metadataFilter?: Record<string, unknown>;
  sourceChannel?: string | null;
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
  pageContext?: AssistantPageContext | null;
}

export type AssistantChatResponse = ChatResponse;

export type AssistantChatStreamEvent = ChatStreamEvent;
