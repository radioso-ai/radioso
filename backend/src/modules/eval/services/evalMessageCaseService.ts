import type { MessageRole } from "../../../db/repositories/messageRepository.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type {
  EvalMessageCaseLookup,
  EvalMessageCaseMutationResult,
  EvalMessageCaseVerification,
} from "../domain/types.js";
import type { CreateSnapshotInput } from "./evalPersistence.js";
import type { EvalSnapshotCaptureInput } from "./evalSnapshotService.js";

export const MAX_EVAL_MESSAGE_VERIFICATION_BATCH = 100;

export interface EvalSourceMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  source: string | null;
  createdAt: Date;
}

export interface FindOrCreateEvalMessageCaseInput {
  workspaceId: string;
  assistantMessageId: string;
  createdBy?: string | null;
  snapshot: CreateSnapshotInput;
  caseName: string;
}

export interface EvalMessageCaseRepositoryPort {
  findSourceMessage(
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<EvalSourceMessage | null>;
  findMessageCase(
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<EvalMessageCaseLookup | null>;
  findOrCreateMessageCase(
    input: FindOrCreateEvalMessageCaseInput,
  ): Promise<EvalMessageCaseMutationResult>;
  lookupMessageCaseVerifications(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, EvalMessageCaseVerification>>;
}

export interface EvalSnapshotPreparerPort {
  prepare(input: EvalSnapshotCaptureInput): Promise<CreateSnapshotInput>;
}

export interface EvalMessageCaseLoggerPort {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface FindOrCreateEvalMessageCaseServiceInput {
  workspaceId: string;
  assistantMessageId: string;
  createdBy?: string | null;
}

const compactQuestion = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const defaultEvalMessageCaseName = (snapshot: CreateSnapshotInput): string => {
  const assistantMessageId = snapshot.replayTarget?.assistantMessageId;
  const assistant = assistantMessageId
    ? snapshot.messages.find((message) => message.id === assistantMessageId)
    : undefined;
  const date = (assistant?.createdAt ?? new Date().toISOString()).slice(0, 10);
  const userMessageId = snapshot.replayTarget?.userMessageId;
  const question = compactQuestion(
    snapshot.messages.find((message) => message.id === userMessageId)?.content ?? "",
  );
  if (!question) {
    return `Eval from ${date}`;
  }
  const prefix = `${date} · "`;
  const available = 200 - prefix.length - 1;
  const snippet = question.length > available
    ? `${question.slice(0, Math.max(0, available - 1)).trimEnd()}…`
    : question;
  return `${prefix}${snippet}"`;
};

export class EvalMessageCaseService {
  constructor(
    private readonly repository: EvalMessageCaseRepositoryPort,
    private readonly snapshots: EvalSnapshotPreparerPort,
    private readonly logger?: EvalMessageCaseLoggerPort,
  ) {}

  async get(
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<EvalMessageCaseLookup> {
    const linked = await this.repository.findMessageCase(workspaceId, assistantMessageId);
    if (!linked) {
      throw notFound("Eval case association not found");
    }
    return linked;
  }

  async findOrCreate(
    input: FindOrCreateEvalMessageCaseServiceInput,
  ): Promise<EvalMessageCaseMutationResult> {
    const source = await this.repository.findSourceMessage(
      input.workspaceId,
      input.assistantMessageId,
    );
    if (!source) {
      throw notFound("Assistant message not found");
    }
    if (
      source.role !== "assistant"
      || (source.source !== null && source.source !== "ai_agent")
    ) {
      throw badRequest("Source message must be an AI-authored assistant message");
    }

    const existing = await this.repository.findMessageCase(
      input.workspaceId,
      input.assistantMessageId,
    );
    if (existing) {
      this.logger?.info({
        workspaceId: input.workspaceId,
        assistantMessageId: input.assistantMessageId,
        caseId: existing.case.id,
        created: false,
      }, "eval_message_case_found");
      return { ...existing, created: false };
    }

    const snapshot = await this.snapshots.prepare({
      workspaceId: input.workspaceId,
      conversationId: source.conversationId,
      messageId: source.id,
      capturedBy: input.createdBy ?? null,
    });
    if (
      snapshot.replayTarget?.assistantMessageId !== input.assistantMessageId
      || !snapshot.replayTarget.userMessageId
    ) {
      throw badRequest("Assistant message has no preceding user message to replay");
    }
    const result = await this.repository.findOrCreateMessageCase({
      workspaceId: input.workspaceId,
      assistantMessageId: input.assistantMessageId,
      createdBy: input.createdBy ?? null,
      snapshot,
      caseName: defaultEvalMessageCaseName(snapshot),
    });
    this.logger?.info({
      workspaceId: input.workspaceId,
      assistantMessageId: input.assistantMessageId,
      caseId: result.case.id,
      created: result.created,
    }, result.created ? "eval_message_case_created" : "eval_message_case_found");
    return result;
  }

  async lookupVerifications(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, EvalMessageCaseVerification>> {
    const uniqueIds = [...new Set(assistantMessageIds)];
    if (uniqueIds.length > MAX_EVAL_MESSAGE_VERIFICATION_BATCH) {
      throw badRequest(
        `At most ${MAX_EVAL_MESSAGE_VERIFICATION_BATCH} assistant message ids may be looked up at once`,
      );
    }
    if (uniqueIds.length === 0) {
      return new Map();
    }
    return this.repository.lookupMessageCaseVerifications(workspaceId, uniqueIds);
  }
}
