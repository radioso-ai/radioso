import { presentChatPayload } from "./chatPresenter.js";
import type { ChatConversationDetail } from "../../../modules/chat/services/chatHistoryService.js";
import type { AnswerSegment, ChatStreamEvent, ChatSuggestion } from "../../../modules/chat/contracts/index.js";
import type { AuditEventInput } from "../../../modules/audit/contracts/index.js";
import {
  isAgentBootstrapActive,
  resolveAgentDisplayName,
  type ConversationAgent,
} from "../../../modules/agents/public.js";

interface PublicChatSessionPresentationInput {
  agent: ConversationAgent;
  workspaceName: string;
  publicChatToken: string;
  session: {
    publicSessionId: string;
    token: string;
    expiresAt: string;
  };
  assistantAvatarUrl: string | null;
  intakeActions?: unknown;
}

export const presentPublicChatSession = ({
  agent,
  workspaceName,
  publicChatToken,
  session,
  assistantAvatarUrl,
  intakeActions,
}: PublicChatSessionPresentationInput) => ({
  workspaceName: resolveAgentDisplayName({
    agentName: agent.name,
    workspaceName,
  }),
  agentId: agent.id,
  agentName: agent.name,
  publicChatToken,
  publicSessionId: session.publicSessionId,
  publicSessionToken: session.token,
  assistantBootstrapActive: isAgentBootstrapActive(agent),
  assistantAvatarUrl,
  theme: agent.theme,
  branding: agent.branding,
  intakeActions,
  expiresAt: session.expiresAt,
});

export const websiteEmbedLaunchAllowedAuditEvent = (input: {
  accountId: string;
  workspaceId: string;
  origin: string;
}): AuditEventInput => ({
  accountId: input.accountId,
  workspaceId: input.workspaceId,
  eventType: "website_embed.launch_allowed",
  eventStatus: "success",
  metadata: { origin: input.origin },
});

export const websiteEmbedLaunchDeniedAuditEvent = (input: {
  accountId: string;
  workspaceId: string;
  origin: string;
  reason?: string;
}): AuditEventInput => ({
  accountId: input.accountId,
  workspaceId: input.workspaceId,
  eventType: "website_embed.launch_denied",
  eventStatus: "failure",
  metadata: {
    origin: input.origin,
    ...(input.reason ? { reason: input.reason } : {}),
  },
});

const stripPublicSuggestionCitation = (suggestion: ChatSuggestion): ChatSuggestion => {
  const { citation: _citation, ...publicSuggestion } = suggestion;
  return publicSuggestion;
};

const stripPublicAnswerSegmentCitations = (answerSegments?: AnswerSegment[]): AnswerSegment[] | undefined =>
  answerSegments?.map((segment) => ({ text: segment.text }));

export const stripPublicChatCitationArtifacts = <T extends {
  citations?: unknown;
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  route?: unknown;
  activitySummary?: unknown;
  activityTrace?: unknown;
  debug?: unknown;
}>(payload: T): Omit<T, "citations" | "answerSegments" | "suggestions" | "route" | "activitySummary" | "activityTrace" | "debug"> & {
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
} => {
  const {
    citations: _citations,
    answerSegments,
    suggestions,
    route: _route,
    activitySummary: _activitySummary,
    activityTrace: _activityTrace,
    debug: _debug,
    ...publicPayload
  } = payload;

  return {
    ...publicPayload,
    ...(answerSegments ? { answerSegments: stripPublicAnswerSegmentCitations(answerSegments) } : {}),
    ...(suggestions ? { suggestions: suggestions.map(stripPublicSuggestionCitation) } : {}),
  };
};

export const stripPublicConversationCitationArtifacts = (
  detail: ChatConversationDetail,
): ChatConversationDetail => ({
  ...detail,
  messages: detail.messages.map((message) => {
    const {
      citations: _citations,
      answerSegments,
      suggestions,
      debug: _debug,
      ...publicMessage
    } = message;

    return {
      ...publicMessage,
      ...(answerSegments ? { answerSegments: stripPublicAnswerSegmentCitations(answerSegments) } : {}),
      ...(suggestions ? { suggestions: suggestions.map(stripPublicSuggestionCitation) } : {}),
    };
  }),
});

export async function* stripPublicStreamCitationArtifacts(
  events: AsyncIterable<ChatStreamEvent>,
): AsyncIterable<ChatStreamEvent> {
  for await (const event of events) {
    if (event.type === "done") {
      yield stripPublicChatCitationArtifacts(presentChatPayload(event)) as ChatStreamEvent;
      continue;
    }

    if (event.type === "suggestions") {
      yield {
        ...event,
        suggestions: event.suggestions.map(stripPublicSuggestionCitation),
      };
      continue;
    }

    yield event;
  }
}
