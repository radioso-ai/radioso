import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { ConversationRepositoryPort } from "../../../db/repositories/conversationRepository.js";
import type { MessageRepositoryPort, MessageRecord } from "../../../db/repositories/messageRepository.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { projectInternalAgentConfig } from "../../agents/public.js";
import type { AnswerSegment, ChatCitation } from "../../chat/contracts/answerTypes.js";
import { freezeRetrievalSettings } from "../../settings/contracts/retrieval.js";
import type { RetrievalSettingsService } from "../../settings/contracts/services.js";
import type { EvalRepositoryPort } from "./evalRepository.js";
import type {
  EvalSnapshot,
  EvalSnapshotFidelity,
  EvalSnapshotMessage,
  EvalSnapshotOriginalRetrievalChunk,
} from "../domain/types.js";

export interface EvalSnapshotCaptureInput {
  workspaceId: string;
  conversationId: string;
  messageId?: string | null;
  capturedBy?: string | null;
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

const toSnapshotMessage = (record: MessageRecord): EvalSnapshotMessage => ({
  id: record.id,
  role: record.role,
  content: record.content,
  createdAt: record.createdAt.toISOString(),
  ...(record.role === "assistant" ? {
    citations: extractCitations(record.metadata),
    answerSegments: extractAnswerSegments(record.metadata),
  } : {}),
});

const extractStringField = (metadata: Record<string, unknown> | undefined, key: string): string | null => {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
    private readonly retrievalSettings: RetrievalSettingsService,
    private readonly repository: EvalRepositoryPort,
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

    const lastMessage = sliced.at(-1);
    const assistantTurn = lastMessage?.role === "assistant" ? lastMessage : undefined;

    const retrieval = assistantTurn ? extractRetrievedChunks(assistantTurn.metadata) : null;
    const instructionBlock = assistantTurn
      ? extractStringField(assistantTurn.metadata, "composedInstructions")
      : null;
    const modelId = assistantTurn ? extractStringField(assistantTurn.metadata, "modelId") : null;

    const fidelity = determineFidelity(assistantTurn, retrieval);

    const agentConfig = conversation.agentId
      ? await this.agents.findByIdAndWorkspaceId(conversation.agentId, input.workspaceId)
          .then((agent) => (agent ? projectInternalAgentConfig(agent) : null))
      : null;

    const settingsSnapshot = await this.retrievalSettings
      .getForWorkspace(input.workspaceId)
      .then(freezeRetrievalSettings);

    return this.repository.createSnapshot({
      workspaceId: input.workspaceId,
      sourceConversationId: conversation.id,
      sourceMessageId: assistantTurn?.id ?? null,
      fidelity,
      messages: sliced.map(toSnapshotMessage),
      originalInstructionBlock: instructionBlock,
      originalModelId: modelId,
      originalRetrievalSettings: settingsSnapshot,
      originalRetrievalResult: retrieval,
      originalAgent: null,
      originalAgentConfig: agentConfig,
      sourceAgentId: agentConfig ? conversation.agentId : null,
      capturedBy: input.capturedBy ?? null,
    });
  }
}
