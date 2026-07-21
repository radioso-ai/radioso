import type { RoutineState } from "@radioso/conversation-contract";
import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { ExternalSkillDefinitionRepositoryPort } from "../../../db/repositories/externalSkillDefinitionRepository.js";
import type { McpConnectionRepositoryPort } from "../../../db/repositories/mcpConnectionRepository.js";
import type { MessageRepositoryPort, MessageRecord } from "../../../db/repositories/messageRepository.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { projectInternalAgentConfig, type InternalAgentExternalSkillsConfig } from "../../agents/public.js";
import type { AnswerSegment, ChatCitation } from "../../chat/contracts/answerTypes.js";
import {
  loadConversationSummaryText,
  type ConversationSummaryStore,
} from "../../chat/contracts/conversationSummary.js";
import type { RetrievalDefaultsProvider, SkillSettingsResolver } from "../../retrieval/public.js";
import { freezeRetrievalSettings } from "../../settings/contracts/retrieval.js";
import type { EvalRepositoryPort } from "./evalRepository.js";
import type {
  EvalSnapshot,
  EvalSnapshotFidelity,
  EvalSnapshotMessage,
  EvalSnapshotOriginalRetrievalChunk,
  EvalSnapshotReplayTarget,
} from "../domain/types.js";

export interface EvalSnapshotCaptureInput {
  workspaceId: string;
  conversationId: string;
  messageId?: string | null;
  capturedBy?: string | null;
}

export interface EvalSnapshotExternalSkillsPort {
  connections: Pick<McpConnectionRepositoryPort, "listByAgent">;
  skillDefinitions: Pick<ExternalSkillDefinitionRepositoryPort, "listByAgent">;
}

/** Reads the active routine position for a conversation so it can be frozen into the
 * snapshot for faithful mid-routine replay. Keyed by sessionId (= conversation id). */
export interface EvalSnapshotRoutineStateReader {
  loadActive(input: { sessionId: string }): Promise<RoutineState | null>;
}

const truncateMessages = (
  messages: MessageRecord[],
  messageId: string | null | undefined,
): MessageRecord[] => {
  if (!messageId) {
    return messages;
  }
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    return messages;
  }
  return messages.slice(0, idx + 1);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const extractCitations = (metadata: Record<string, unknown> | undefined): ChatCitation[] | undefined => {
  const raw = metadata?.citations;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const citations = raw.flatMap((value): ChatCitation[] => {
    if (!isRecord(value)) {
      return [];
    }
    const { documentId, chunkId, title, sourceUrl } = value;
    if (typeof documentId !== "string" || typeof chunkId !== "string" || typeof title !== "string") {
      return [];
    }
    return [{
      documentId,
      chunkId,
      title,
      ...(typeof sourceUrl === "string" && sourceUrl.length > 0 ? { sourceUrl } : {}),
    }];
  });

  return citations.length > 0 ? citations : undefined;
};

const extractAnswerSegments = (metadata: Record<string, unknown> | undefined): AnswerSegment[] | undefined => {
  const raw = metadata?.answerSegments;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const segments = raw.flatMap((value): AnswerSegment[] => {
    if (!isRecord(value) || typeof value.text !== "string") {
      return [];
    }
    const citationIndices = Array.isArray(value.citationIndices)
      ? value.citationIndices.filter((index): index is number => Number.isInteger(index) && index >= 0)
      : undefined;
    return [{
      text: value.text,
      ...(citationIndices && citationIndices.length > 0 ? { citationIndices } : {}),
    }];
  });

  return segments.length > 0 ? segments : undefined;
};

const extractGroundingSummary = (metadata: Record<string, unknown> | undefined): EvalSnapshotMessage["groundingSummary"] => {
  const verdict = metadata?.groundingVerdict;
  const protocolVersion = metadata?.groundingProtocolVersion;
  const diagnostics = metadata?.groundingDiagnostics;
  if (
    (verdict !== "grounded" && verdict !== "degraded" && verdict !== "no_support")
    || (protocolVersion !== 1 && protocolVersion !== 2 && protocolVersion !== null)
    || !isRecord(diagnostics)
  ) {
    return undefined;
  }
  const parseStatus = diagnostics.parseStatus;
  if (![
    "valid_v2", "legacy_v1", "missing", "malformed", "invalid_v2",
  ].includes(String(parseStatus))) {
    return undefined;
  }
  const readCount = (key: string): number =>
    typeof diagnostics[key] === "number" && Number.isInteger(diagnostics[key]) ? diagnostics[key] : 0;
  return {
    protocolVersion,
    parseStatus: parseStatus as "valid_v2" | "legacy_v1" | "missing" | "malformed" | "invalid_v2",
    verdict,
    claimCount: readCount("claimCount"),
    sourcedClaimCount: readCount("sourcedClaimCount"),
    unsourcedClaimCount: readCount("unsourcedClaimCount"),
    invalidSourceCount: readCount("invalidSourceCount"),
    assertionMismatch: diagnostics.assertionMismatch === true,
  };
};

const extractDirectiveFirings = (metadata: Record<string, unknown> | undefined): string[] | undefined => {
  const value = metadata?.directiveFirings;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names = [...new Set(value.filter((name): name is string => typeof name === "string" && name.length > 0))];
  return names.length > 0 ? names : undefined;
};

const toSnapshotMessage = (record: MessageRecord): EvalSnapshotMessage => {
  const directiveFirings = record.role === "assistant"
    ? extractDirectiveFirings(record.metadata)
    : undefined;
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt.toISOString(),
    ...(record.role === "assistant" ? {
      citations: extractCitations(record.metadata),
      answerSegments: extractAnswerSegments(record.metadata),
      groundingSummary: extractGroundingSummary(record.metadata),
      ...(directiveFirings ? { directiveFirings } : {}),
    } : {}),
  };
};

const resolveReplayTarget = (messages: MessageRecord[], messageId: string | null | undefined): EvalSnapshotReplayTarget | null => {
  if (messages.length === 0) {
    return null;
  }
  const selectedIndex = messageId
    ? messages.findIndex((message) => message.id === messageId)
    : messages.length - 1;
  if (selectedIndex < 0) {
    return null;
  }
  const selected = messages[selectedIndex];
  if (!selected) {
    return null;
  }
  if (selected.role === "user") {
    return {
      userMessageId: selected.id,
      assistantMessageId: null,
    };
  }

  const userMessage = messages
    .slice(0, selectedIndex)
    .reverse()
    .find((message) => message.role === "user");
  if (!userMessage) {
    return null;
  }
  return {
    userMessageId: userMessage.id,
    assistantMessageId: selected.role === "assistant" ? selected.id : null,
  };
};

const extractStringField = (metadata: Record<string, unknown> | undefined, key: string): string | null => {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * The pre-answer rolling summary (#866) persisted on an assistant message.
 * `absent` = legacy pre-feature message (no key); `present` with a null summary =
 * the turn ran under summary-aware code and saw no summary. The distinction drives
 * whether snapshot capture may fall back to the current summary row.
 */
type PerTurnConversationSummary =
  | { kind: "present"; summary: string | null }
  | { kind: "absent" };

const readPerTurnConversationSummary = (
  metadata: Record<string, unknown> | undefined,
): PerTurnConversationSummary => {
  if (!metadata || !("conversationSummary" in metadata)) {
    return { kind: "absent" };
  }
  const value = metadata.conversationSummary;
  const summary = typeof value === "string" ? value.trim() : "";
  return { kind: "present", summary: summary.length > 0 ? summary : null };
};

const extractRetrievedChunks = (
  metadata: Record<string, unknown> | undefined,
): EvalSnapshotOriginalRetrievalChunk[] | null => {
  if (!metadata) return null;
  const chunks = metadata.retrievedChunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const mapped: EvalSnapshotOriginalRetrievalChunk[] = [];
  for (const [index, raw] of chunks.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const chunkId = typeof c.chunkId === "string" ? c.chunkId : null;
    const documentId = typeof c.documentId === "string" ? c.documentId : null;
    if (!chunkId || !documentId) continue;
    mapped.push({
      chunkId,
      documentId,
      title: typeof c.title === "string" ? c.title : "",
      rank: typeof c.rank === "number" ? c.rank : index,
      similarity: typeof c.similarity === "number" ? c.similarity : undefined,
      fusedScore: typeof c.fusedScore === "number" ? c.fusedScore : undefined,
      semanticScore: typeof c.semanticScore === "number" ? c.semanticScore : undefined,
      lexicalScore: typeof c.lexicalScore === "number" ? c.lexicalScore : undefined,
      lexicalRankScore: typeof c.lexicalRankScore === "number" ? c.lexicalRankScore : undefined,
      metadata: c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata)
        ? c.metadata as Record<string, unknown>
        : undefined,
    });
  }
  return mapped.length > 0 ? mapped : null;
};

const determineFidelity = (
  assistantMessage: MessageRecord | undefined,
  retrieval: EvalSnapshotOriginalRetrievalChunk[] | null,
): EvalSnapshotFidelity => {
  if (!assistantMessage) {
    return "messages_only";
  }
  return retrieval ? "full" : "messages_only";
};

export class EvalSnapshotService {
  constructor(
    private readonly conversations: ConversationRepositoryPort,
    private readonly messages: MessageRepositoryPort,
    private readonly agents: AgentRepositoryPort,
    private readonly retrievalDefaultsProvider: RetrievalDefaultsProvider,
    private readonly skillSettingsResolver: SkillSettingsResolver,
    private readonly repository: EvalRepositoryPort,
    private readonly externalSkills?: EvalSnapshotExternalSkillsPort,
    private readonly routineStateReader?: EvalSnapshotRoutineStateReader,
    // Freeze the rolling conversation summary (#866) at capture time so a replay/eval
    // run sees the same pre-window context a live turn would. Narrow read-only port.
    private readonly conversationSummaryStore?: Pick<ConversationSummaryStore, "load">,
  ) {}

  async getById(workspaceId: string, snapshotId: string): Promise<EvalSnapshot> {
    const snapshot = await this.repository.findSnapshot(workspaceId, snapshotId);
    if (!snapshot) {
      throw notFound("Snapshot not found");
    }
    return snapshot;
  }

  async capture(input: EvalSnapshotCaptureInput): Promise<EvalSnapshot> {
    const conversation = await this.conversations.findByIdAndWorkspaceId(
      input.conversationId,
      input.workspaceId,
    );
    if (!conversation) {
      throw notFound("Conversation not found");
    }

    const allMessages = await this.messages.listByConversationId(
      input.workspaceId,
      input.conversationId,
    );
    if (allMessages.length === 0) {
      throw badRequest("Cannot capture a snapshot from an empty conversation");
    }

    const sliced = truncateMessages(allMessages, input.messageId ?? null);
    if (input.messageId && sliced.length === allMessages.length && !sliced.some((m) => m.id === input.messageId)) {
      throw notFound("Message not found in conversation");
    }

    const replayTarget = resolveReplayTarget(sliced, input.messageId ?? null);
    const assistantTurn = replayTarget?.assistantMessageId
      ? sliced.find((message) => message.id === replayTarget.assistantMessageId && message.role === "assistant")
      : undefined;

    const retrieval = assistantTurn ? extractRetrievedChunks(assistantTurn.metadata) : null;
    const instructionBlock = assistantTurn
      ? extractStringField(assistantTurn.metadata, "composedInstructions")
      : null;
    const modelId = assistantTurn ? extractStringField(assistantTurn.metadata, "modelId") : null;

    const fidelity = determineFidelity(assistantTurn, retrieval);

    const agent = conversation.agentId
      ? await this.agents.findByIdAndWorkspaceId(conversation.agentId, input.workspaceId)
      : null;
    const externalSkills = agent && conversation.agentId
      ? await this.loadExternalSkills(conversation.agentId)
      : null;
    const agentConfig = agent
      ? projectInternalAgentConfig(agent, externalSkills ? { externalSkills } : {})
      : null;
    // Capture the conversation's current routine position as reference data (sessionId
    // stripped). This is the post-turn/current state — NOT a faithful pre-turn seed for
    // the captured assistant turn — so the run service does not auto-apply it; it is
    // surfaced for operators and as a starting point for an explicit override.
    const activeRoutine = this.routineStateReader
      ? await this.routineStateReader.loadActive({ sessionId: conversation.id })
      : null;
    const originalRoutineState = activeRoutine
      ? (({ sessionId: _sessionId, ...rest }) => rest)(activeRoutine)
      : null;

    // Freeze the rolling summary (#866) that the captured turn actually saw.
    //
    // - Answered-turn capture: the per-turn pre-answer summary persisted on the
    //   assistant message metadata is the faithful value — the exact text the turn's
    //   prompts saw, recorded BEFORE that turn's own fire-and-forget regeneration could
    //   distill the answer we are about to re-generate. The current summary row is NOT
    //   used here (it typically already reflects the answer). A legacy pre-feature
    //   message has no per-turn value, so we fall back to the current row only when it
    //   provably predates the replayed turn (see resolveAnsweredTurnSummary).
    // - Next-turn / conversation-level capture (no answered assistant turn): the current
    //   row IS the faithful pre-window context the next live turn would receive, so it is
    //   frozen as-is (best-effort; a missing store or read failure degrades to none).
    const conversationSummary = assistantTurn
      ? await this.resolveAnsweredTurnSummary({
          conversationId: conversation.id,
          assistantTurn,
          replayTarget,
          messages: sliced,
        })
      : await loadConversationSummaryText(this.conversationSummaryStore, conversation.id);

    const defaults = this.retrievalDefaultsProvider.getDefaults(input.workspaceId);
    const settingsSnapshot = freezeRetrievalSettings(
      agent
        ? this.skillSettingsResolver.resolve(
            "retrieval.answer",
            defaults,
            agent.skillSettings["retrieval.answer"],
          )
        : defaults,
    );

    return this.repository.createSnapshot({
      workspaceId: input.workspaceId,
      sourceConversationId: conversation.id,
      sourceMessageId: replayTarget?.assistantMessageId ?? null,
      replayTarget,
      fidelity,
      messages: sliced.map(toSnapshotMessage),
      originalInstructionBlock: instructionBlock,
      originalModelId: modelId,
      originalRetrievalSettings: settingsSnapshot,
      originalRetrievalResult: retrieval,
      originalAgent: null,
      originalAgentConfig: agentConfig,
      sourceAgentId: agentConfig ? conversation.agentId : null,
      originalRoutineState,
      ...(conversationSummary ? { conversationSummary } : {}),
      capturedBy: input.capturedBy ?? null,
    });
  }

  /**
   * The faithful pre-answer summary for an answered-turn capture. Prefers the per-turn
   * value persisted on the assistant message; only a legacy (pre-feature) message falls
   * back to the current row, and then only when that row provably predates the answer.
   */
  private async resolveAnsweredTurnSummary(input: {
    conversationId: string;
    assistantTurn: MessageRecord;
    replayTarget: EvalSnapshotReplayTarget | null;
    messages: MessageRecord[];
  }): Promise<string | undefined> {
    const perTurn = readPerTurnConversationSummary(input.assistantTurn.metadata);
    if (perTurn.kind === "present") {
      // The turn ran under summary-aware code: its persisted pre-answer value is
      // authoritative — a string is frozen, an explicit null means the turn saw no
      // summary (omit, with no fallback that could leak the answer).
      return perTurn.summary ?? undefined;
    }
    return this.loadPreAnswerSummaryFallback(input);
  }

  /**
   * Legacy fallback: no per-turn summary was recorded on the assistant message. Include
   * the current summary row only if its watermark (`coveredThrough`) is strictly before
   * the replayed user message — proof it derives solely from messages preceding the
   * replayed turn and therefore cannot contain the answer being re-generated.
   */
  private async loadPreAnswerSummaryFallback(input: {
    conversationId: string;
    replayTarget: EvalSnapshotReplayTarget | null;
    messages: MessageRecord[];
  }): Promise<string | undefined> {
    if (!this.conversationSummaryStore) {
      return undefined;
    }
    const userMessageId = input.replayTarget?.userMessageId;
    const replayedUserMessage = userMessageId
      ? input.messages.find((message) => message.id === userMessageId)
      : undefined;
    if (!replayedUserMessage) {
      return undefined;
    }
    try {
      const record = await this.conversationSummaryStore.load({ sessionId: input.conversationId });
      const summary = record?.summary.trim();
      if (!record || !summary) {
        return undefined;
      }
      return record.coveredThrough.getTime() < replayedUserMessage.createdAt.getTime()
        ? summary
        : undefined;
    } catch {
      // Best-effort, off the answer path: a read failure degrades to no summary.
      return undefined;
    }
  }

  private async loadExternalSkills(agentId: string): Promise<InternalAgentExternalSkillsConfig | null> {
    if (!this.externalSkills) {
      return null;
    }
    const [connections, skills] = await Promise.all([
      this.externalSkills.connections.listByAgent(agentId),
      this.externalSkills.skillDefinitions.listByAgent(agentId),
    ]);
    return {
      connections: connections.map((connection) => ({
        id: connection.id,
        displayName: connection.displayName,
        serverUrl: connection.serverUrl,
        authMethod: connection.authMethod,
        hasCredential: Boolean(connection.credentialCiphertext),
      })),
      skills: skills.map((skill) => ({
        skillName: skill.skillName,
        connectionId: skill.connectionId,
        toolName: skill.toolName,
        boundParams: skill.boundParams,
        exposedParams: skill.exposedParams,
        declaredOutcomes: skill.declaredOutcomes,
        outcomeMap: skill.outcomeMap,
        enabled: skill.enabled,
      })),
    };
  }
}
