import type { ChatStreamEvent } from "../contracts/streamEvents.js";
import type { ChatBootstrapResponse, ChatResponse } from "./chatResponses.js";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

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
  channelContext?: ConversationChannelContext | null;
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
  agentId?: string | null;
  accountId?: string;
  conversationId?: string;
  message?: string;
  bootstrapGreetingId?: string;
  startConversation?: boolean;
  stream: boolean;
  userExpectedLocale?: string | null;
  inputMetadata?: import("../../../db/repositories/messageRepository.js").UserMessageInputMetadata;
  sourceContext?: AssistantSourceContext;
  metadataFilter?: Record<string, unknown>;
  sourceChannel?: string | null;
  channelContext?: ConversationChannelContext | null;
  chatSessionId?: string | null;
  /** @deprecated Use chatSessionId. Kept for older public-chat callers during the rename. */
  anonymousSessionId?: string | null;
  sourceOrigin?: string | null;
  pageContext?: AssistantPageContext | null;
  verifiedCustomerId?: string | null;
  verifiedIdentity?: Record<string, unknown> | null;
}

export type AssistantChatResponse = ChatResponse | ChatBootstrapResponse;

export type AssistantChatStreamEvent = ChatStreamEvent;
