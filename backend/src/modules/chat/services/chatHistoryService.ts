import { notFound } from "../../../shared/domain/errors.js";
import { decodeCursorWithKeys } from "../../../shared/domain/cursorPagination.js";
import type { ConversationSourceScope } from "../../../shared/domain/conversationSource.js";
import type { ConversationTurnStage } from "../contracts/interruption.js";
import type { ConversationOwnershipScope } from "../../handoff/public.js";
import type { AuditEventRecord, AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import type {
  ConversationRepositoryPort,
} from "../../../db/repositories/conversationRepository.js";
import type { ConversationOwnershipRecord } from "../../../db/repositories/conversationOwnershipRepository.js";
import type {
  MessageRecord,
  MessageRepositoryPort,
} from "../../../db/repositories/messageRepository.js";
import { deriveMessageSourceFromRole } from "../../../db/repositories/messageRepository.js";
import type { HistoryItemsRepositoryPort } from "../../../db/repositories/historyItemsRepository.js";
import type { DocumentSearchHistoryEntry } from "../../documents/contracts/index.js";
import type { ConversationChannelContext } from "@radioso/conversation-contract";
import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import {
  ActivitySummaryPresenter,
  type RetrievalExecutionDiagnostics,
  type ActivitySummary,
  type ActivityTrace,
} from "../../retrieval/public.js";
import {
  type AssistantTurnOutcome,
  type SkillTurnOutcome,
  skillTurnOutcomeFromLegacyAnswerOutcome,
} from "./assistantTurnOutcomeTypes.js";
import { skillDisplayMetadataSchema, skillOutcomeStatusSchema, type SkillDisplayMetadata } from "../../skills/public.js";
import type { ChatSuggestion } from "../types/chatResponses.js";
import { buildChatConversationSummary, buildHistoryItem } from "./historyItemPresenter.js";
import {
  LEGACY_TURN_TRACE_ENVELOPE_VERSION,
  buildTurnTraceEnvelope,
  synthesizeDispatchSpine,
  type TurnTraceEnvelope,
} from "./turnTraceEnvelope.js";
import { RETRIEVAL_TRACE_LEAF, capabilitySubTrace } from "./chatTraceLeaves.js";
import {
  NoopContactHistoryProvider,
  type ContactHistoryDetail,
  type ContactHistoryPage,
  type ContactHistoryProviderPort,
  type ContactHistorySummary,
} from "./contactHistoryProvider.js";
import {
  NoopAnswerFeedbackHistoryProvider,
  type AnswerFeedbackHistoryProviderPort,
  type ChatAnswerFeedbackEntry,
} from "./answerFeedbackHistoryProvider.js";

// Read-surface projection of conversation ownership (Date fields as ISO strings). Mirrors
// the OpenAPI ConversationOwnership schema and the write surface's ownership envelope.
export interface ChatConversationOwnership {
  conversationId: string;
  workspaceId: string;
  state: ConversationOwnershipRecord["state"];
  ownerAccountId: string | null;
  ownerDisplayName: string | null;
  reason: string | null;
  version: number;
  takenOverAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Narrow read port the history service needs — single load for detail, batch for lists
// (no N+1). A missing entry means AI-owned (the ownership table is lazy).
export interface ConversationOwnershipHistoryReader {
  load(conversationId: string): Promise<ConversationOwnershipRecord | null>;
  loadByConversationIds(conversationIds: string[]): Promise<Map<string, ConversationOwnershipRecord>>;
}

class NoopConversationOwnershipReader implements ConversationOwnershipHistoryReader {
  async load(): Promise<ConversationOwnershipRecord | null> {
    return null;
  }
  async loadByConversationIds(): Promise<Map<string, ConversationOwnershipRecord>> {
    return new Map();
  }
}

const toChatConversationOwnership = (record: ConversationOwnershipRecord): ChatConversationOwnership => ({
  conversationId: record.conversationId,
  workspaceId: record.workspaceId,
  state: record.state,
  ownerAccountId: record.ownerAccountId,
  ownerDisplayName: record.ownerDisplayName,
  reason: record.reason,
  version: record.version,
  takenOverAt: record.takenOverAt ? toIsoString(record.takenOverAt) : null,
  createdAt: toIsoString(record.createdAt),
  updatedAt: toIsoString(record.updatedAt),
});

export interface ChatConversationSummary {
  id: string;
  agentId: string | null;
  agentName: string | null;
  agentInternalName: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  channelContext: ConversationChannelContext | null;
  anonymousSessionId: string | null;
  entryPageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string | null;
  ownership?: ChatConversationOwnership;
}

export interface ChatConversationTurnDebug {
  // "cancelled" covers a turn that had already produced an assistant message (a
  // suspended/durable turn) before a newer message superseded it. Kept distinct from
  // "failure" so this never reads as an assistant error.
  eventStatus: "success" | "failure" | "cancelled";
  recordedAt: string;
  stream: boolean;
  citationCount: number;
  answerOutcome?: AssistantTurnOutcome;
  skillName?: string;
  skillOutcome?: string;
  skillStatus?: SkillTurnOutcome["status"];
  activitySummary?: ActivitySummary;
  activityTrace?: ActivityTrace;
  // Conversation spine as the root span with capability traces as typed leaves.
  // Preferred from persisted metadata; synthesized (version 0) for legacy turns.
  turnTrace?: TurnTraceEnvelope;
  errorMessage?: string | null;
  route?: {
    generator: string;
    routeType: "direct" | "retrieval";
    routeReason: string;
    retrievalInvoked: boolean;
  };
}

/**
 * Debug fact for a user turn that never got a reply: a genuine failure, or a turn a
 * newer message superseded before it could answer. Both leave no assistant message
 * behind, so the fact is attached to the user's own message instead — the turn's only
 * other trace is a `chat_turn_cancelled`/error log line an operator cannot query by
 * conversation. Deliberately a separate, smaller shape than `ChatConversationTurnDebug`:
 * there is no retrieval/activity/turn trace to show for a turn that never finished.
 */
export interface ChatConversationTurnFailure {
  eventStatus: "failure" | "cancelled";
  recordedAt: string;
  stream: boolean;
  /** Present for a "cancelled" event: the pipeline stage the newer message interrupted. */
  stage?: ConversationTurnStage;
  /** Present only for a genuine "failure"; a "cancelled" turn has no error to show. */
  errorMessage?: string | null;
}

export interface ChatConversationTurn {
  id: string;
  role: MessageRecord["role"];
  source: NonNullable<MessageRecord["source"]>;
  content: string;
  createdAt: string;
  inputMetadata?: MessageRecord["inputMetadata"];
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  answerFeedbackEntries?: ChatAnswerFeedbackEntry[];
  debug?: ChatConversationTurnDebug;
  /**
   * Set only when the conversation is read with `includeTurnFailureDebug` (the
   * dashboard surface). A DASHBOARD-only operator diagnostic: it can carry raw error
   * text, so it must never reach the public/embed visitor surface, which shares this
   * read path.
   */
  turnFailure?: ChatConversationTurnFailure;
  /**
   * Display name of the human operator who authored this turn (a takeover reply),
   * so the visitor can see who is answering. Only the name is exposed — never the
   * operator's account id.
   */
  operatorDisplayName?: string;
}

/** Reads the operator's display name from a human-agent reply's stored metadata. */
const operatorDisplayNameFrom = (message: MessageRecord): string | undefined => {
  const humanAgent = (message.metadata as { humanAgent?: { displayName?: unknown } } | undefined)?.humanAgent;
  const displayName = humanAgent?.displayName;
  return typeof displayName === "string" && displayName.trim().length > 0 ? displayName : undefined;
};

export interface ChatConversationDetail {
  conversationId: string;
  workspaceId: string;
  agentId: string | null;
  agentName: string | null;
  agentInternalName?: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  channelContext: ConversationChannelContext | null;
  entryPageUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  messagesTotal: number;
  messageWindowOffset: number;
  messageWindowLimit: number;
  hasOlderMessages: boolean;
  nextCursor: string | null;
  tailCursor: string | null;
  messages: ChatConversationTurn[];
  ownership?: ChatConversationOwnership;
}

export interface ChatConversationTail {
  messages: ChatConversationTurn[];
  cursor: string | null;
  ownership?: ChatConversationOwnership;
}

export interface ChatConversationPage {
  conversations: ChatConversationSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export type HistoryItem =
  | {
      kind: "chat";
      id: string;
      sortAt: string;
      conversation: ChatConversationSummary;
    }
  | {
      kind: "search";
      id: string;
      sortAt: string;
      search: DocumentSearchHistoryEntry;
    }
  | {
      kind: "contact";
      id: string;
      sortAt: string;
      contact: ContactHistorySummary;
    };

export interface HistoryItemsPage {
  items: HistoryItem[];
  total: number;
  nextCursor: null;
  hasMore: boolean;
}

export interface ContactHistoryDetailResponse {
  contact: ContactHistoryDetail;
  conversation: ChatConversationDetail;
}

export interface PublicConversationSummary {
  id: string;
  agentId: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  preview: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicConversationPage {
  conversations: PublicConversationSummary[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

interface ChatAuditMetadata {
  answerOutcome?: AssistantTurnOutcome;
  skillTurn?: unknown;
  skillIntake?: unknown;
  userMessageId?: string;
  assistantMessageId?: string;
  stream?: boolean;
  citationCount?: number;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: unknown[];
  retrieval?: unknown;
  activityTrace?: ActivityTrace;
  turnTrace?: TurnTraceEnvelope;
  errorMessage?: string;
  // Present on a "cancelled" chat.answer event: the pipeline stage a newer message
  // interrupted (see ConversationTurnStage / ChatTurnSupersededError).
  supersededStage?: ConversationTurnStage;
  route?: {
    generator?: unknown;
    routeType?: unknown;
    routeReason?: unknown;
    retrievalInvoked?: unknown;
  };
}

interface NormalizedSkillTurnOutcome {
  skillName: string;
  outcome?: string;
  status: SkillTurnOutcome["status"];
}

const normalizeSkillStatus = (value: unknown): SkillTurnOutcome["status"] | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = skillOutcomeStatusSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
};

const normalizeSkillTurnFields = (input: {
  skillName?: unknown;
  skillOutcome?: unknown;
  skillStatus?: unknown;
  requireOutcome: boolean;
}): NormalizedSkillTurnOutcome | undefined => {
  if (typeof input.skillName !== "string" || input.skillName.trim().length === 0) {
    return undefined;
  }
  const status = normalizeSkillStatus(input.skillStatus);
  if (!status) {
    return undefined;
  }
  const outcome = typeof input.skillOutcome === "string" && input.skillOutcome.trim().length > 0
    ? input.skillOutcome.trim()
    : undefined;
  if (input.requireOutcome && !outcome) {
    return undefined;
  }

  return {
    skillName: input.skillName.trim(),
    outcome,
    status,
  };
};

const normalizeSkillIntakeOutcome = (value: unknown): NormalizedSkillTurnOutcome | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { skillName?: unknown; skillOutcome?: unknown; status?: unknown };
  const normalized = normalizeSkillTurnFields({
    skillName: candidate.skillName,
    skillOutcome: candidate.skillOutcome,
    skillStatus: candidate.status,
    requireOutcome: false,
  });
  return normalized
    ? {
        ...normalized,
        outcome: normalized.outcome ?? "unknown",
      }
    : undefined;
};

const normalizeMessageSkillTurnOutcome = (message: MessageRecord | undefined): NormalizedSkillTurnOutcome | undefined =>
  normalizeSkillTurnFields({
    skillName: message?.skillName,
    skillOutcome: message?.skillOutcome,
    skillStatus: message?.skillStatus,
    requireOutcome: false,
  });

const normalizeSkillTurnOutcome = (
  metadata: ChatAuditMetadata,
  message: MessageRecord | undefined,
): NormalizedSkillTurnOutcome | undefined => {
  if (metadata.skillTurn && typeof metadata.skillTurn === "object" && !Array.isArray(metadata.skillTurn)) {
    const candidate = metadata.skillTurn as { skillName?: unknown; outcome?: unknown; status?: unknown };
    const normalized = normalizeSkillTurnFields({
      skillName: candidate.skillName,
      skillOutcome: candidate.outcome,
      skillStatus: candidate.status,
      requireOutcome: true,
    });
    if (normalized) {
      return normalized;
    }
  }

  const messageSkillTurnOutcome = normalizeMessageSkillTurnOutcome(message);
  if (messageSkillTurnOutcome) {
    return messageSkillTurnOutcome;
  }

  const skillIntakeOutcome = normalizeSkillIntakeOutcome(metadata.skillIntake);
  if (skillIntakeOutcome) {
    return skillIntakeOutcome;
  }

  return skillTurnOutcomeFromLegacyAnswerOutcome(metadata.answerOutcome);
};

interface AssistantTurnArtifacts {
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeSuggestionCitation = (value: unknown): ChatCitation | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { documentId?: unknown; chunkId?: unknown; title?: unknown };
  if (
    typeof candidate.documentId !== "string" ||
    typeof candidate.chunkId !== "string" ||
    typeof candidate.title !== "string"
  ) {
    return undefined;
  }

  return {
    documentId: candidate.documentId,
    chunkId: candidate.chunkId,
    title: candidate.title,
  };
};

const normalizeSuggestionKind = (value: unknown): ChatSuggestion["kind"] | null => {
  // Legacy rows persisted before `kind` was required defaulted to deeper suggestions.
  if (value === undefined) {
    return "deeper";
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeSuggestionAction = (
  value: unknown,
): NonNullable<ChatSuggestion["action"]> | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as { kind?: unknown; intent?: unknown };
  if (candidate.kind === "ask_followup") {
    return { kind: "ask_followup" };
  }
  if (candidate.kind !== "start_intent") {
    return undefined;
  }
  if (!candidate.intent || typeof candidate.intent !== "object") {
    return undefined;
  }
  const intentCandidate = candidate.intent as { skillName?: unknown; intentName?: unknown; display?: unknown };
  if (typeof intentCandidate.skillName !== "string" || intentCandidate.skillName.trim().length === 0) {
    return undefined;
  }
  const intent: { skillName: string; intentName?: string; display?: SkillDisplayMetadata } = {
    skillName: intentCandidate.skillName.trim(),
  };
  if (typeof intentCandidate.intentName === "string" && intentCandidate.intentName.trim().length > 0) {
    intent.intentName = intentCandidate.intentName.trim();
  }
  const display = skillDisplayMetadataSchema.safeParse(intentCandidate.display);
  if (display.success) {
    intent.display = display.data;
  }
  return { kind: "start_intent", intent };
};

const normalizeChatSuggestion = (value: unknown): ChatSuggestion | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    text?: unknown;
    kind?: unknown;
    citation?: unknown;
    action?: unknown;
  };
  if (typeof candidate.text !== "string") {
    return null;
  }

  const text = normalizeWhitespace(candidate.text);
  if (!text) {
    return null;
  }

  const kind = normalizeSuggestionKind(candidate.kind);
  if (!kind) {
    return null;
  }

  const citation = normalizeSuggestionCitation(candidate.citation);
  const action = normalizeSuggestionAction(candidate.action);

  const result: ChatSuggestion = { text, kind };
  if (citation) {
    result.citation = citation;
  }
  if (action) {
    result.action = action;
  }
  return result;
};

const toIsoString = (value: Date): string => value.toISOString();

const normalizeRouteDiagnostics = (
  value: ChatAuditMetadata["route"],
): ChatConversationTurnDebug["route"] | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const generator = typeof value.generator === "string" && value.generator.trim()
    ? value.generator.trim()
    : undefined;
  const routeType =
    value.routeType === "direct" || value.routeType === "retrieval"
      ? value.routeType
      : undefined;
  const routeReason = typeof value.routeReason === "string" ? value.routeReason : undefined;

  if (!generator || !routeType || !routeReason) {
    return undefined;
  }

  return {
    generator,
    routeType,
    routeReason,
    retrievalInvoked: Boolean(value.retrievalInvoked),
  };
};

const toRetrievalExecutionPath = (
  route: ChatConversationTurnDebug["route"] | undefined,
): ActivitySummary["execution"] | undefined => {
  if (!route || route.generator !== "assistant") {
    return undefined;
  }

  return {
    surface: "assistant",
    path: route.routeType === "direct" ? "assistant_direct" : "assistant_retrieval",
    retrievalInvoked: route.retrievalInvoked,
  };
};

/**
 * Wrap a legacy turn's (reconstructed) activity trace in a version-0 envelope so
 * the renderer treats old turns like new ones. The spine is a single synthetic
 * dispatch stage — there was no engine spine when these turns were recorded.
 */
const synthesizeLegacyTurnTrace = (input: {
  activityTrace: ActivityTrace | undefined;
  skillName: string | undefined;
  startedAt: string;
}): TurnTraceEnvelope | undefined => {
  if (!input.activityTrace) {
    return undefined;
  }
  return buildTurnTraceEnvelope({
    version: LEGACY_TURN_TRACE_ENVELOPE_VERSION,
    spine: synthesizeDispatchSpine({
      skillName: input.skillName ?? "assistant",
      startedAt: input.activityTrace.startedAt ?? input.startedAt,
      completedAt: input.activityTrace.completedAt,
      subTrace: capabilitySubTrace(RETRIEVAL_TRACE_LEAF, input.activityTrace),
    }),
  });
};

const reconstructActivityTrace = (input: {
  eventId: string;
  startedAt: string;
  route: ChatConversationTurnDebug["route"] | undefined;
  summary: ActivitySummary | undefined;
  diagnostics: RetrievalExecutionDiagnostics;
  answerOutcome?: AssistantTurnOutcome;
  skillTurnOutcome?: NormalizedSkillTurnOutcome;
  citations?: ChatCitation[];
}): ActivityTrace => {
  const execution = input.summary?.execution ?? toRetrievalExecutionPath(input.route);
  const stages: ActivityTrace["stages"] = [
    {
      stageId: "routing",
      kind: "routing",
      label: "Routing",
      status: input.route?.retrievalInvoked ? "applied" : "skipped",
      startedAt: input.startedAt,
      inputs: {
        surface: execution?.surface,
      },
      outputs: {
        retrievalInvoked: input.route?.retrievalInvoked,
        retrievalSkipped: input.diagnostics.retrievalSkipped,
      },
      reason: input.route?.routeReason,
    },
  ];

  if (input.diagnostics.parsedQuery || input.diagnostics.rewriteStatus || input.diagnostics.retrievalSubqueries?.length) {
    stages.push({
      stageId: "interpretation",
      kind: "query_interpretation",
      label: "Query interpretation",
      status: input.diagnostics.rewriteStatus === "fallback"
        ? "fallback"
        : input.diagnostics.rewriteStatus === "rejected"
          ? "rejected"
          : input.diagnostics.rewriteStatus === "applied"
            ? "applied"
            : "skipped",
      startedAt: input.startedAt,
      outputs: {
        originalQuery: input.diagnostics.parsedQuery?.originalQuery,
        semanticQuery: input.diagnostics.parsedQuery?.semanticQuery,
        lexicalQuery: input.diagnostics.parsedQuery?.lexicalQuery,
        retrievalSubqueries: input.diagnostics.retrievalSubqueries,
        rewriteEligible: input.diagnostics.rewriteEligible,
        rewriteRan: input.diagnostics.rewriteRan,
        continuityDecision: input.diagnostics.continuityDecision,
      },
      reason: input.diagnostics.rejectionReason ?? input.diagnostics.fallbackReason,
    });
  }

  if (input.diagnostics.triggerAnalysis) {
    stages.push({
      stageId: "trigger_analysis",
      kind: "trigger_analysis",
      label: "Trigger analysis",
      status: input.diagnostics.triggerAnalysis.status === "fallback"
        ? "fallback"
        : input.diagnostics.triggerAnalysis.status === "applied"
          ? "applied"
          : "skipped",
      startedAt: input.startedAt,
      outputs: {
        consideredRules: input.diagnostics.triggerAnalysis.consideredRules,
        matchedRuleIds: input.diagnostics.triggerAnalysis.matchedRuleIds,
        unmatchedRuleIds: input.diagnostics.triggerAnalysis.unmatchedRuleIds,
        backoffDecision: input.diagnostics.triggerBackoff,
      },
      metrics: {
        consideredRuleCount: input.diagnostics.triggerAnalysis.consideredRules.length,
        matchCount: input.diagnostics.triggerAnalysis.matchCount,
      },
      reason: input.diagnostics.triggerAnalysis.failureReason,
    });
  }

  if (input.diagnostics.shapeSelection || input.summary?.shapeName || input.summary?.skillDiagnostic) {
    stages.push({
      stageId: "shape_selection",
      kind: "shape_selection",
      label: "Shape selection",
      status: "applied",
      startedAt: input.startedAt,
      outputs: {
        skillName: input.summary?.skillDiagnostic?.skillName,
        shapeName: input.summary?.shapeName,
        queryShape: input.summary?.queryShape,
        resolvedSteps: input.summary?.resolvedSteps,
      },
      reason: input.summary?.skillDiagnostic?.selectionReason,
    });
  }

  const citationChunkRefs = (input.citations ?? []).map((citation) => ({
    chunkId: citation.chunkId,
    documentId: citation.documentId,
    title: citation.title,
  }));

  stages.push(
    {
      stageId: "candidate_summary",
      kind: "diagnostics",
      label: "Candidate summary",
      status: input.diagnostics.fallbackApplied ? "fallback" : "applied",
      startedAt: input.startedAt,
      outputs: {
        fallbackApplied: input.diagnostics.fallbackApplied,
        continuityDecision: input.diagnostics.continuityDecision,
        ...(citationChunkRefs.length > 0 ? { finalContexts: citationChunkRefs } : {}),
      },
      metrics: {
        semanticCandidateCount: input.diagnostics.originalCandidateCount + input.diagnostics.rewrittenCandidateCount,
        lexicalCandidateCount: input.diagnostics.lexicalCandidateCount ?? 0,
        mergedCandidateCount: input.diagnostics.normalizedCandidateCount,
        finalContextCount: input.diagnostics.finalContextCount,
      },
    },
    {
      stageId: "answer",
      kind: "answer_outcome",
      label: "Answer outcome",
      status: "applied",
      startedAt: input.startedAt,
      outputs: {
        outcome: input.answerOutcome,
        skillName: input.skillTurnOutcome?.skillName,
        skillOutcome: input.skillTurnOutcome?.outcome,
        skillStatus: input.skillTurnOutcome?.status,
      },
    },
  );

  return {
    traceId: `reconstructed-${input.eventId}`,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    totalDurationMs: 0,
    stages,
    links: stages.slice(0, -1).map((stage, index) => ({
      fromStageId: stage.stageId,
      toStageId: stages[index + 1]?.stageId ?? stage.stageId,
      kind: "sequence",
    })),
    summary: input.summary,
  };
};

export class ChatHistoryService {
  private readonly activitySummaryPresenter = new ActivitySummaryPresenter();

  constructor(
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly auditEventRepository: AuditEventRepositoryPort,
    private readonly historyItemsRepository: HistoryItemsRepositoryPort,
    private readonly contactHistoryProvider: ContactHistoryProviderPort = new NoopContactHistoryProvider(),
    private readonly answerFeedbackHistoryProvider: AnswerFeedbackHistoryProviderPort =
      new NoopAnswerFeedbackHistoryProvider(),
    private readonly conversationOwnership: ConversationOwnershipHistoryReader =
      new NoopConversationOwnershipReader(),
  ) {}

  async listConversations(
    workspaceId: string,
    input: {
      limit: number;
      offset?: number;
      cursor?: string;
      sourceScope?: ConversationSourceScope;
      ownership?: ConversationOwnershipScope;
    } = { limit: 50, offset: 0 },
  ): Promise<ChatConversationPage> {
    const { conversations, total, nextCursor, hasMore } = await this.conversationRepository.listPageByWorkspaceId(
      workspaceId,
      { ...input, sourceScope: input.sourceScope ?? "end_user" },
    );
    const conversationIds = conversations.map((conversation) => conversation.id);
    const [messageSummaries, ownershipByConversationId] = await Promise.all([
      this.messageRepository.summarizeByConversationIds(workspaceId, conversationIds),
      this.conversationOwnership.loadByConversationIds(conversationIds),
    ]);

    return {
      conversations: conversations.map((conversation) => {
        const summary = buildChatConversationSummary(conversation, messageSummaries.get(conversation.id));
        const ownership = ownershipByConversationId.get(conversation.id);
        // Only human-owned conversations carry ownership; an ai_owned row (e.g. after a
        // hand-back) reads the same as no row — absent means AI-owned.
        return ownership?.state === "human_owned"
          ? { ...summary, ownership: toChatConversationOwnership(ownership) }
          : summary;
      }),
      total,
      nextCursor,
      hasMore,
    };
  }

  async listItems(
    workspaceId: string,
    input: { limit: number; offset?: number; sourceScope?: ConversationSourceScope } = { limit: 50, offset: 0 },
  ): Promise<HistoryItemsPage> {
    const offset = input.offset ?? 0;
    const sourceLimit = offset + input.limit;
    const sourceScope = input.sourceScope ?? "end_user";
    const [basePage, contactPage] = await Promise.all([
      this.historyItemsRepository.listPageByWorkspaceId(workspaceId, {
        limit: sourceLimit,
        offset: 0,
        sourceScope,
      }),
      this.contactHistoryProvider.listPageByWorkspaceId(workspaceId, { limit: sourceLimit, offset: 0 }),
    ]);
    const baseItems = basePage.items;
    const contactItems = contactPage.contacts.map((contact): HistoryItem => ({
      kind: "contact",
      id: contact.id,
      sortAt: contact.sortAt,
      contact,
    }));
    const mergedItems = [
      ...baseItems.map((item): HistoryItem => buildHistoryItem(item)),
      ...contactItems,
    ].sort((left, right) => {
      const timeDiff = new Date(right.sortAt).getTime() - new Date(left.sortAt).getTime();
      return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
    });
    const items = mergedItems.slice(offset, offset + input.limit);
    const conversationIds = items.flatMap((item) => item.kind === "chat" ? [item.conversation.id] : []);
    const messageSummaries = await this.messageRepository.summarizeByConversationIds(workspaceId, conversationIds);
    const total = basePage.total + contactPage.total;

    return {
      items: items.map((item): HistoryItem => {
        if (item.kind !== "chat") {
          return item;
        }

        return {
          ...item,
          conversation: {
            ...item.conversation,
            messageCount: messageSummaries.get(item.conversation.id)?.messageCount ?? 0,
            userMessageCount: messageSummaries.get(item.conversation.id)?.userMessageCount ?? 0,
            assistantMessageCount: messageSummaries.get(item.conversation.id)?.assistantMessageCount ?? 0,
            preview: messageSummaries.get(item.conversation.id)?.preview ?? null,
          },
        };
      }),
      total,
      nextCursor: null,
      hasMore: offset + items.length < total,
    };
  }

  async listContacts(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ): Promise<ContactHistoryPage> {
    return this.contactHistoryProvider.listPageByWorkspaceId(workspaceId, input);
  }

  async getContactRequest(
    workspaceId: string,
    requestId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
    options: {
      includeAnswerFeedback?: boolean;
      includeOwnership?: boolean;
      includeAgentInternalName?: boolean;
    } = { includeAnswerFeedback: true },
  ): Promise<ContactHistoryDetailResponse> {
    const contact = await this.contactHistoryProvider.getById(workspaceId, requestId);
    if (!contact) {
      throw notFound("Contact request not found");
    }

    return {
      contact,
      conversation: await this.getConversation(workspaceId, contact.conversationId, input, options),
    };
  }

  async listAnonymousConversations(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null } = { limit: 50, offset: 0 },
  ): Promise<PublicConversationPage> {
    const { conversations, total, nextCursor, hasMore } = await this.conversationRepository.listPageByAnonymousSession(
      workspaceId,
      anonymousSessionId,
      input,
    );
    const messageSummaries = await this.messageRepository.summarizeByConversationIds(
      workspaceId,
      conversations.map((conversation) => conversation.id),
    );

    return {
      conversations: conversations.map((conversation) => {
        const summary = messageSummaries.get(conversation.id);
        return {
          id: conversation.id,
          agentId: conversation.agentId,
          sourceChannel: conversation.sourceChannel,
          sourceOrigin: conversation.sourceOrigin,
          preview: summary?.preview ?? null,
          messageCount: summary?.messageCount ?? 0,
          createdAt: toIsoString(conversation.createdAt),
          updatedAt: toIsoString(conversation.updatedAt),
        };
      }),
      total,
      nextCursor,
      hasMore,
    };
  }

  async getConversation(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
    // includeOwnership is OFF by default: ownership exposes the operator's identity and is
    // a DASHBOARD-only concern. The public/embed visitor surface shares this method and must
    // never receive it.
    options: {
      includeAnswerFeedback?: boolean;
      includeOwnership?: boolean;
      // The internal agent label is an operator-only presentation fact. It must never reach
      // the public/embed visitor surface, which shares this read method.
      includeAgentInternalName?: boolean;
      // OFF by default: this can carry raw error text for a failed turn and is a
      // DASHBOARD-only operator diagnostic. The public/embed visitor path calls this
      // method directly and must never set it.
      includeTurnFailureDebug?: boolean;
    } = {},
  ): Promise<ChatConversationDetail> {
    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    const [{ messages, total, nextCursor, hasMore }, messageSummaries, ownershipRecord, tailBaseline, turnFailureEvents] = await Promise.all([
      this.messageRepository.listWindowByConversationId(workspaceId, conversation.id, input),
      this.messageRepository.summarizeByConversationIds(workspaceId, [conversation.id]),
      options.includeOwnership ? this.conversationOwnership.load(conversation.id) : Promise.resolve(null),
      this.messageRepository.listSinceByConversationId(workspaceId, conversation.id, {
        limit: 1,
      }),
      options.includeTurnFailureDebug
        ? this.auditEventRepository.listChatAnswerEventsByConversationId(workspaceId, conversation.id)
        : Promise.resolve<AuditEventRecord[]>([]),
    ]);
    const assistantMessageIds = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id);
    const auditEvents = await this.auditEventRepository.listChatTurnEventsByAssistantMessageIds(
      workspaceId,
      conversation.id,
      assistantMessageIds,
    );
    const feedbackByAssistantMessageId = options.includeAnswerFeedback
      ? await this.answerFeedbackHistoryProvider.listByAssistantMessageIds(workspaceId, assistantMessageIds)
      : new Map<string, ChatAnswerFeedbackEntry[]>();

    const artifactsByAssistantMessageId = this.buildArtifactsIndex(auditEvents);
    const debugByAssistantMessageId = this.buildDebugIndex(auditEvents, messages);
    const turnFailureByUserMessageId = options.includeTurnFailureDebug
      ? this.buildTurnFailureIndex(turnFailureEvents)
      : new Map<string, ChatConversationTurnFailure>();
    const messageSummary = messageSummaries.get(conversation.id);

    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      agentName: conversation.agentName,
      ...(options.includeAgentInternalName
        ? { agentInternalName: conversation.agentInternalName, entryPageUrl: conversation.entryPageUrl }
        : {}),
      sourceChannel: conversation.sourceChannel,
      sourceOrigin: conversation.sourceOrigin,
      channelContext: conversation.channelContext,
      createdAt: toIsoString(conversation.createdAt),
      updatedAt: toIsoString(conversation.updatedAt),
      messageCount: messageSummary?.messageCount ?? total,
      userMessageCount: messageSummary?.userMessageCount ?? 0,
      assistantMessageCount: messageSummary?.assistantMessageCount ?? 0,
      messagesTotal: total,
      messageWindowOffset: input.offset ?? 0,
      messageWindowLimit: input.limit,
      hasOlderMessages: hasMore,
      nextCursor,
      tailCursor: tailBaseline.latestCursor,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        source: message.source ?? deriveMessageSourceFromRole(message.role),
        content: message.content,
        createdAt: toIsoString(message.createdAt),
        inputMetadata: message.inputMetadata,
        citations: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.citations : undefined,
        answerSegments: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.answerSegments : undefined,
        suggestions: message.role === "assistant" ? artifactsByAssistantMessageId.get(message.id)?.suggestions : undefined,
        answerFeedbackEntries: message.role === "assistant" ? feedbackByAssistantMessageId.get(message.id) : undefined,
        debug: message.role === "assistant" ? debugByAssistantMessageId.get(message.id) : undefined,
        turnFailure: message.role === "user" ? turnFailureByUserMessageId.get(message.id) : undefined,
        operatorDisplayName: operatorDisplayNameFrom(message),
      })),
      ...(ownershipRecord?.state === "human_owned"
        ? { ownership: toChatConversationOwnership(ownershipRecord) }
        : {}),
    };
  }

  async tailConversation(
    workspaceId: string,
    conversationId: string,
    input: { cursor?: string; limit: number },
    options: { includeOwnership?: boolean } = {},
  ): Promise<ChatConversationTail> {
    const conversation = await this.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);

    if (!conversation) {
      throw notFound("Conversation not found");
    }

    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const [{ messages, latestCursor }, ownershipRecord] = await Promise.all([
      this.messageRepository.listSinceByConversationId(workspaceId, conversation.id, {
        sinceCreatedAt: cursor ? new Date(cursor.keys.createdAt) : undefined,
        sinceId: cursor?.keys.id,
        limit: input.limit,
      }),
      options.includeOwnership ? this.conversationOwnership.load(conversation.id) : Promise.resolve(null),
    ]);

    return {
      messages: messages.map((message) => this.toLightweightConversationTurn(message)),
      cursor: latestCursor,
      ...(ownershipRecord?.state === "human_owned"
        ? { ownership: toChatConversationOwnership(ownershipRecord) }
        : {}),
    };
  }

  private toLightweightConversationTurn(message: MessageRecord): ChatConversationTurn {
    return {
      id: message.id,
      role: message.role,
      source: message.source ?? deriveMessageSourceFromRole(message.role),
      content: message.content,
      createdAt: toIsoString(message.createdAt),
      inputMetadata: message.inputMetadata,
      operatorDisplayName: operatorDisplayNameFrom(message),
    };
  }

  private buildDebugIndex(
    auditEvents: AuditEventRecord[],
    messages: MessageRecord[],
  ): Map<string, ChatConversationTurnDebug> {
    const index = new Map<string, ChatConversationTurnDebug>();
    const messagesById = new Map(messages.map((message) => [message.id, message]));

    for (const event of auditEvents) {
      const metadata = event.metadata as ChatAuditMetadata;
      if (!metadata.assistantMessageId) {
        continue;
      }

      const skillTurnOutcome = normalizeSkillTurnOutcome(metadata, messagesById.get(metadata.assistantMessageId));
      const route = normalizeRouteDiagnostics(metadata.route);
      const activitySummary = metadata.activityTrace?.summary
        ?? (
          metadata.retrieval
            ? this.activitySummaryPresenter.present(metadata.retrieval as RetrievalExecutionDiagnostics, {
                execution: toRetrievalExecutionPath(route),
              })
            : undefined
        );
      const activityTrace = metadata.activityTrace
        ?? (
          metadata.retrieval
            ? reconstructActivityTrace({
                eventId: event.id,
                startedAt: toIsoString(event.createdAt),
                route,
                summary: activitySummary,
                diagnostics: metadata.retrieval as RetrievalExecutionDiagnostics,
                answerOutcome: metadata.answerOutcome,
                skillTurnOutcome,
                citations: metadata.citations,
              })
            : undefined
        );
      // Prefer the persisted envelope; for turns recorded before it existed,
      // synthesize a legacy (version 0) one wrapping the reconstructed activity
      // trace as a retrieval leaf so the renderer always receives an envelope.
      const turnTrace = metadata.turnTrace
        ?? synthesizeLegacyTurnTrace({
          activityTrace,
          skillName: skillTurnOutcome?.skillName,
          startedAt: toIsoString(event.createdAt),
        });
      index.set(metadata.assistantMessageId, {
        // Preserve all three states: collapsing "cancelled" into "success" would show a
        // superseded turn as a completed answer; collapsing it into "failure" would show
        // a routine interruption as an assistant error.
        eventStatus: event.eventStatus === "success"
          ? "success"
          : event.eventStatus === "cancelled"
            ? "cancelled"
            : "failure",
        recordedAt: toIsoString(event.createdAt),
        stream: Boolean(metadata.stream),
        citationCount: typeof metadata.citationCount === "number" ? metadata.citationCount : 0,
        answerOutcome: metadata.answerOutcome,
        ...(skillTurnOutcome
          ? {
              skillName: skillTurnOutcome.skillName,
              skillOutcome: skillTurnOutcome.outcome,
              skillStatus: skillTurnOutcome.status,
            }
          : {}),
        activitySummary,
        activityTrace,
        turnTrace,
        errorMessage: metadata.errorMessage ?? null,
        route,
      });
    }

    return index;
  }

  /**
   * Indexes `chat.answer` events that never produced an assistant message — a genuine
   * failure or a superseded turn — by the user message they belong to. These are the
   * only turns `buildDebugIndex` cannot reach: it keys strictly by `assistantMessageId`,
   * which is exactly what a turn with no reply never has.
   */
  private buildTurnFailureIndex(
    auditEvents: AuditEventRecord[],
  ): Map<string, ChatConversationTurnFailure> {
    const index = new Map<string, ChatConversationTurnFailure>();

    for (const event of auditEvents) {
      const metadata = event.metadata as ChatAuditMetadata;
      if (metadata.assistantMessageId || typeof metadata.userMessageId !== "string") {
        continue;
      }
      if (event.eventStatus !== "failure" && event.eventStatus !== "cancelled") {
        continue;
      }

      index.set(metadata.userMessageId, {
        eventStatus: event.eventStatus,
        recordedAt: toIsoString(event.createdAt),
        stream: Boolean(metadata.stream),
        stage: metadata.supersededStage,
        errorMessage: metadata.errorMessage ?? null,
      });
    }

    return index;
  }

  private buildArtifactsIndex(
    auditEvents: AuditEventRecord[],
  ): Map<string, AssistantTurnArtifacts> {
    const index = new Map<string, AssistantTurnArtifacts>();

    for (const event of auditEvents) {
      const metadata = event.metadata as ChatAuditMetadata;
      if (!metadata.assistantMessageId) {
        continue;
      }

      index.set(metadata.assistantMessageId, {
        citations: metadata.citations,
        answerSegments: metadata.answerSegments,
        suggestions: Array.isArray(metadata.suggestions)
          ? metadata.suggestions.flatMap((suggestion) => {
              const normalized = normalizeChatSuggestion(suggestion);
              return normalized ? [normalized] : [];
            })
          : undefined,
      });
    }

    return index;
  }
}
