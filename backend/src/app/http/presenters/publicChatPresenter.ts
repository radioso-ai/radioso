import { presentChatPayload } from "./chatPresenter.js";
import type { ChatConversationDetail, ChatConversationTail } from "../../../modules/chat/services/chatHistoryService.js";
import {
  CitationAnchorSanitizer,
  type AnswerSegment,
  type ChatCitation,
  type ChatStreamEvent,
  type ChatSuggestion,
} from "../../../modules/chat/contracts/index.js";
import type { AuditEventInput } from "../../../modules/audit/contracts/index.js";
import {
  getWebsiteEmbedSurfaceSettings,
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
}: PublicChatSessionPresentationInput) => {
  const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
  return {
    workspaceName: resolveAgentDisplayName({
      agentName: agent.name,
      workspaceName,
    }),
    agentId: agent.id,
    agentName: agent.name,
    assistantLinkUtmEnabled: agent.assistantLinkUtmEnabled,
    citationDisplayEnabled: agent.citationDisplayEnabled,
    publicChatToken,
    publicSessionId: session.publicSessionId,
    publicSessionToken: session.token,
    resumeToken: resume.token,
    assistantBootstrapActive: isAgentBootstrapActive(agent),
    assistantAvatarUrl,
    theme: agent.theme,
    copy: websiteEmbed.copy,
    branding: agent.branding,
    intakeActions,
    expiresAt: session.expiresAt,
    resumeExpiresAt: resume.expiresAt,
  };
};

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

const stripPublicAnswerSegmentCitations = (
  answerSegments: AnswerSegment[] | undefined,
  exposeCitations: boolean,
): AnswerSegment[] | undefined =>
  answerSegments?.map((segment) =>
    exposeCitations && segment.citationIndices
      ? { text: segment.text, citationIndices: segment.citationIndices }
      : { text: segment.text },
  );

// Public surfaces expose a citation's human-facing label and outbound link, but
// never the internal document/chunk identifiers — anonymous visitors must not be
// able to open the underlying source document.
const toPublicCitation = (citation: ChatCitation): ChatCitation => ({
  documentId: "",
  chunkId: "",
  title: citation.title,
  ...(citation.sourceUrl ? { sourceUrl: citation.sourceUrl } : {}),
});

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
}>(payload: T, exposeCitations: boolean): Omit<T, "citations" | "answerSegments" | "suggestions" | "route" | "activitySummary" | "activityTrace" | "debug"> & {
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
} => {
  const {
    citations,
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
    ...(exposeCitations && Array.isArray(citations)
      ? { citations: (citations as ChatCitation[]).map(toPublicCitation) }
      : {}),
    ...(answerSegments ? { answerSegments: stripPublicAnswerSegmentCitations(answerSegments, exposeCitations) } : {}),
    ...(suggestions ? { suggestions: suggestions.map(stripPublicSuggestionCitation) } : {}),
  };
};

export const stripPublicConversationCitationArtifacts = (
  detail: ChatConversationDetail,
  anonymousSessionId: string,
  exposeCitations: boolean,
): ChatConversationDetail => ({
  ...detail,
  messages: detail.messages.map((message) => {
    const {
      citations,
      answerSegments,
      suggestions,
      answerFeedbackEntries,
      debug: _debug,
      turnFailure: _turnFailure,
      ...publicMessage
    } = message;
    const publicAnswerFeedbackEntries = message.role === "assistant"
      ? filterPublicAnswerFeedbackEntries(answerFeedbackEntries, anonymousSessionId)
      : undefined;

    return {
      ...publicMessage,
      ...(exposeCitations && Array.isArray(citations)
        ? { citations: (citations as ChatCitation[]).map(toPublicCitation) }
        : {}),
      ...(answerSegments ? { answerSegments: stripPublicAnswerSegmentCitations(answerSegments, exposeCitations) } : {}),
      ...(suggestions ? { suggestions: suggestions.map(stripPublicSuggestionCitation) } : {}),
      ...(publicAnswerFeedbackEntries && publicAnswerFeedbackEntries.length > 0
        ? { answerFeedbackEntries: publicAnswerFeedbackEntries }
        : {}),
    };
  }),
});

export const stripPublicConversationTailCitationArtifacts = (
  tail: ChatConversationTail,
  exposeCitations: boolean,
): Omit<ChatConversationTail, "ownership"> => {
  const { ownership: _ownership, ...publicTail } = tail;
  return {
    ...publicTail,
    messages: tail.messages.map((message) => {
      const {
        citations,
        answerSegments,
        suggestions,
        answerFeedbackEntries: _answerFeedbackEntries,
        debug: _debug,
        turnFailure: _turnFailure,
        ...publicMessage
      } = message;

      return {
        ...publicMessage,
        ...(exposeCitations && Array.isArray(citations)
          ? { citations: (citations as ChatCitation[]).map(toPublicCitation) }
          : {}),
        ...(answerSegments ? { answerSegments: stripPublicAnswerSegmentCitations(answerSegments, exposeCitations) } : {}),
        ...(suggestions ? { suggestions: suggestions.map(stripPublicSuggestionCitation) } : {}),
      };
    }),
  };
};

export async function* stripPublicStreamCitationArtifacts(
  events: AsyncIterable<ChatStreamEvent>,
  exposeCitations: boolean,
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
      yield stripPublicChatCitationArtifacts(presentChatPayload(event), exposeCitations) as ChatStreamEvent;
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
