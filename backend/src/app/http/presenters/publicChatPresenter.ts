import { presentChatPayload } from "./chatPresenter.js";
import type { ChatConversationDetail } from "../../../modules/chat/services/chatHistoryService.js";
import {
  CitationAnchorSanitizer,
  type AnswerSegment,
  type ChatStreamEvent,
  type ChatSuggestion,
} from "../../../modules/chat/contracts/index.js";
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
  resume: {
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
  resume,
  assistantAvatarUrl,
  intakeActions,
}: PublicChatSessionPresentationInput) => ({
  workspaceName: resolveAgentDisplayName({
    agentName: agent.name,
    workspaceName,
  }),
  agentId: agent.id,
  agentName: agent.name,
  assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
  publicChatToken,
  publicSessionId: session.publicSessionId,
  publicSessionToken: session.token,
  resumeToken: resume.token,
  assistantBootstrapActive: isAgentBootstrapActive(agent),
  assistantAvatarUrl,
  theme: agent.theme,
  branding: agent.branding,
  intakeActions,
  expiresAt: session.expiresAt,
  resumeExpiresAt: resume.expiresAt,
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

type ConversationFeedbackEntry = NonNullable<ChatConversationDetail["messages"][number]["answerFeedbackEntries"]>[number];

const filterPublicAnswerFeedbackEntries = (
  entries: ConversationFeedbackEntry[] | undefined,
  anonymousSessionId: string,
): ConversationFeedbackEntry[] | undefined => {
  if (!entries) {
    return undefined;
  }

  return entries.filter((entry) =>
    entry.actorType === "anonymous_user" &&
    entry.anonymousSessionId === anonymousSessionId,
  );
};

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
  anonymousSessionId: string,
): ChatConversationDetail => ({
  ...detail,
  messages: detail.messages.map((message) => {
    const {
      citations: _citations,
      answerSegments,
      suggestions,
      answerFeedbackEntries,
      debug: _debug,
      ...publicMessage
    } = message;
    const publicAnswerFeedbackEntries = message.role === "assistant"
      ? filterPublicAnswerFeedbackEntries(answerFeedbackEntries, anonymousSessionId)
      : undefined;

    return {
      ...publicMessage,
      ...(answerSegments ? { answerSegments: stripPublicAnswerSegmentCitations(answerSegments) } : {}),
      ...(suggestions ? { suggestions: suggestions.map(stripPublicSuggestionCitation) } : {}),
      ...(publicAnswerFeedbackEntries && publicAnswerFeedbackEntries.length > 0
        ? { answerFeedbackEntries: publicAnswerFeedbackEntries }
        : {}),
    };
  }),
});

export async function* stripPublicStreamCitationArtifacts(
  events: AsyncIterable<ChatStreamEvent>,
): AsyncIterable<ChatStreamEvent> {
  const chunkSanitizer = new CitationAnchorSanitizer();

  for await (const event of events) {
    if (event.type === "chunk") {
      yield {
        ...event,
        text: chunkSanitizer.push(event.text),
      };
      continue;
    }

    if (event.type === "done") {
      chunkSanitizer.flush();
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
