import type { ChatStreamEvent } from "../contracts/streamEvents.js";
import type { ChatBootstrapResponse, ChatResponse } from "./chatResponses.js";
import type { ConversationChannelContext, ConversationRequestContext } from "@radioso/conversation-contract";
import type { PageReadCapability } from "../services/pageRead/pageReadDecision.js";
import type { RoutineInvocation } from "../contracts/routineInvocation.js";

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
  surface?: "authenticated_chat" | "public_chat" | "website_embed" | "mcp";
  sourceOrigin?: string | null;
  channelContext?: ConversationChannelContext | null;
}

export interface AssistantPageContext {
  pageUrl?: string | null;
  pageTitle?: string | null;
  pageLocale?: string | null;
  browserLocale?: string | null;
  content?: string | null;
  /** FR-013 (spec 1277): document.referrer of the host page; client-claimed, capped and http(s)-only. */
  referrer?: string | null;
}

export interface AssistantClientContextCapabilities {
  "page.read"?: PageReadCapability;
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
  clientContextCapabilities?: AssistantClientContextCapabilities;
  verifiedCustomerId?: string | null;
  verifiedIdentity?: Record<string, unknown> | null;
  /** Edge-observed facts for this turn's first message (spec 1277); ignored for a resumed conversation. */
  requestContext?: ConversationRequestContext | null;
  /** FR-013 (spec 1277): client-claimed referrer of the host page, from pageContext.referrer; persisted once alongside entry_page_url. */
  entryReferrer?: string | null;
  /** Unauthenticated visitor-grouping id from the verified public chat session payload (spec 1277 decision 6); never a credential. */
  visitorKey?: string | null;
  /**
   * Operator-only workbench test override: routine definition ids (drafts included)
   * to make eligible for this turn. Set only by the authenticated workbench chat so an
   * author can test-run an unpublished routine; never present on public-chat requests.
   */
  previewRoutineIds?: string[];
  /**
   * A calling agent's tool call, already resolved and validated against the
   * release's catalog (`resolveAgentTurnInput`). When present, `message` is
   * derived from it and the turn admits the named routine directly.
   */
  routineInvocation?: RoutineInvocation;
}

export type AssistantChatResponse = ChatResponse | ChatBootstrapResponse;

export type AssistantChatStreamEvent = ChatStreamEvent;
