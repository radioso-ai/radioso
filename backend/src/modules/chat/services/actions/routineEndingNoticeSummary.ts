import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../../shared/infra/llm/modelInferencePipeline.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../../db/repositories/messageRepository.js";
import { SharedAnswerInstructionBuilder } from "../../../retrieval/public.js";
import { transcriptCopyContent } from "../../../../shared/domain/sensitiveTranscript.js";

const MAX_MESSAGES_BEFORE_ENDING = 6;
// Even empty messages consume more than six rendered characters. Eight hundred rows therefore
// cover every message that can survive the 4,800-character newest-first budget, plus the prefix.
const MAX_TRANSCRIPT_QUERY_MESSAGES = 800;
const MAX_MESSAGE_CHARS = 700;
const MAX_TRANSCRIPT_CHARS = 4_800;
const MAX_SUMMARY_CHARS = 900;
const TRANSCRIPT_ELISION = "[Earlier routine context omitted for length]";
export const ROUTINE_NOTICE_SUMMARY_TIMEOUT_MS = 10_000;

const compact = (value: string, max: number): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
};

const transcript = (messages: readonly MessageRecord[]): string => {
  let remaining = MAX_TRANSCRIPT_CHARS;
  const lines: string[] = [];
  let omitted = false;
  for (const message of [...messages].reverse()) {
    if (message.role === "system") continue;
    // A turn whose routine held a sensitive value is withheld (#1543); the collected values
    // already arrive with a sensitive slot masked.
    const line = `${message.role.toUpperCase()}: ${compact(transcriptCopyContent(message), MAX_MESSAGE_CHARS)}`;
    if (line.length + 1 > remaining) { omitted = true; break; }
    lines.unshift(line);
    remaining -= line.length + 1;
  }
  if (!omitted) return lines.join("\n");
  while (lines.length > 0 && [TRANSCRIPT_ELISION, ...lines].join("\n").length > MAX_TRANSCRIPT_CHARS) {
    lines.shift();
  }
  return [TRANSCRIPT_ELISION, ...lines].join("\n");
};

export interface RoutineEndingNoticeSummaryGenerator {
  generate(input: {
    workspaceId: string;
    accountId: string | null;
    conversationId: string;
    endingMessageId: string;
    routineStartMessageId?: string;
    outputLanguage?: string;
    collected: Record<string, string | number | boolean>;
    signal?: AbortSignal;
  }): Promise<string | null>;
}

/** Generates a bounded summary at outbox dispatch time; it never participates in a visitor turn. */
export class ModelRoutineEndingNoticeSummaryGenerator implements RoutineEndingNoticeSummaryGenerator {
  private readonly answerInstructions = new SharedAnswerInstructionBuilder();

  constructor(
    private readonly messages: Pick<MessageRepositoryPort, "findByIdAndWorkspaceId" | "listBeforeByConversationId">,
    private readonly inference: ModelInferencePipeline,
  ) {}

  async generate(input: Parameters<RoutineEndingNoticeSummaryGenerator["generate"]>[0]): Promise<string | null> {
    const ending = await this.messages.findByIdAndWorkspaceId(input.workspaceId, input.endingMessageId);
    const before = await this.messages.listBeforeByConversationId(input.workspaceId, input.conversationId, {
      beforeMessageId: input.endingMessageId,
      limit: MAX_TRANSCRIPT_QUERY_MESSAGES,
    });
    input.signal?.throwIfAborted();
    if (!ending) return null;
    const start = input.routineStartMessageId ? before.findIndex((message) => message.id === input.routineStartMessageId) : -1;
    const source = transcript([
      ...(start >= 0
        ? before.slice(Math.max(0, start - MAX_MESSAGES_BEFORE_ENDING))
        : before.slice(-MAX_MESSAGES_BEFORE_ENDING)),
      ending,
    ]);
    if (!source) return null;
    const systemPrompt = renderPromptTemplate("chat/routine-operator-notice-summary.md", {
      response_language_instruction: this.answerInstructions.build({
        responseLanguagePolicy: "match_user_question",
        responseLanguage: input.outputLanguage,
      }).responseLanguageInstruction,
    });
    const prompt = renderPromptTemplate("chat/routine-operator-notice-summary-data.md", {
      collected_values: Object.entries(input.collected).map(([key, value]) => `${key}: ${String(value)}`).join("\n") || "(none)",
      transcript: source,
    });
    const usageContext: ModelCallUsageContext = {
      workspaceId: input.workspaceId, accountId: input.accountId, conversationId: input.conversationId,
      messageId: input.endingMessageId, surface: "assistant", operation: "routine_operator_notice_summary",
      attemptKey: `routine_operator_notice_summary:${input.conversationId}:${input.endingMessageId}`,
    };
    input.signal?.throwIfAborted();
    const { text } = await this.inference.complete({
      operation: usageContext,
      systemPrompt,
      prompt,
      reasoningEffort: "minimal",
      maxOutputTokens: 512,
      signal: input.signal,
    });
    const summary = compact(sanitizeSummary(text ?? ""), MAX_SUMMARY_CHARS);
    return summary || null;
  }
}

const sanitizeSummary = (value: string): string => value
  .replace(/\[([^\]]+)\]\(\s*https?:\/\/[^)]+\)/giu, "$1")
  .replace(/https?:\/\/[^\s<>()]+/giu, "")
  .replace(/(?<![\p{L}\p{N}._%+-])@[\p{L}_][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*/gu, "");
