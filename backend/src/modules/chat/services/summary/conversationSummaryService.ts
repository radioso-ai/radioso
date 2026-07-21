import { CHAT_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { ReasoningEffort } from "../../../../shared/infra/llm/providerTypes.js";
import type { ModelInferencePipeline } from "../../../../shared/infra/llm/modelInferencePipeline.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { MessageRecord, MessageRepositoryPort } from "../../../../db/repositories/messageRepository.js";
import type {
  ConversationSummaryRecord,
  ConversationSummaryStore,
} from "../../contracts/conversationSummary.js";

/** The narrow message-read slice the summary regeneration needs. */
export type ConversationSummaryMessageReader = Pick<
  MessageRepositoryPort,
  "countByConversationId" | "listRecentByConversationId"
>;

/** Generates a fresh summary from the assembled prompt. Wraps the shared inference seam. */
export interface ConversationSummaryGenerator {
  generate(input: { prompt: string; usageContext: ModelCallUsageContext }): Promise<string>;
}

/** Post-turn trigger consumed by the turn lifecycle; fire-and-forget, never awaited. */
export interface ConversationSummaryUpdater {
  refresh(input: { workspaceId: string; conversationId: string; accountId?: string }): Promise<void>;
}

/** The size bounds the regeneration honors; widened from the composition-owned defaults. */
export interface ConversationSummaryConfig {
  minMessages: number;
  refreshEveryMessages: number;
  maxSourceMessages: number;
  maxSourceMessageChars: number;
  maxSummaryChars: number;
}

/** Model-call knobs for the generator; distinct from the size bounds the service applies. */
export interface ConversationSummaryGenerationConfig {
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

// Single truncation rule for everything this service clamps. Slicing UTF-16 code
// units can split a surrogate pair; a lone surrogate becomes U+FFFD on the way
// into Postgres and would then poison every prompt the summary is injected into,
// so back the cut off one unit when it would land mid-pair.
const truncateWithEllipsis = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  let cut = maxLength - 1;
  const beforeCut = value.charCodeAt(cut - 1);
  if (beforeCut >= HIGH_SURROGATE_START && beforeCut <= HIGH_SURROGATE_END) {
    cut -= 1;
  }
  return `${value.slice(0, cut).trimEnd()}…`;
};

const clampExcerpt = (value: string, maxLength: number): string =>
  truncateWithEllipsis(normalizeWhitespace(value), maxLength);

const clampSummary = (value: string, maxLength: number): string =>
  truncateWithEllipsis(value.trim(), maxLength);

/**
 * Regenerates (never appends) the rolling per-conversation summary (#866) off the
 * critical path after a turn completes. Below the message threshold the raw window
 * already carries the whole conversation, so it skips without an LLM call. Above it,
 * one LLM call rewrites the previous summary plus a bounded tail of recent messages
 * into a fresh, hard-clamped summary and upserts it under the watermark guard.
 *
 * All observability here is content-free: it records durations, counts, and reasons,
 * never the summary text, message content, or prompt.
 */
export class ConversationSummaryService implements ConversationSummaryUpdater {
  private readonly config: ConversationSummaryConfig;

  constructor(
    private readonly store: ConversationSummaryStore,
    private readonly messages: ConversationSummaryMessageReader,
    private readonly generator: ConversationSummaryGenerator,
    private readonly logger?: Pick<AppLogger, "debug" | "warn">,
    config: Partial<ConversationSummaryConfig> = {},
  ) {
    this.config = {
      minMessages: CHAT_BEHAVIOR.conversationSummary.minMessages,
      refreshEveryMessages: CHAT_BEHAVIOR.conversationSummary.refreshEveryMessages,
      maxSourceMessages: CHAT_BEHAVIOR.conversationSummary.maxSourceMessages,
      maxSourceMessageChars: CHAT_BEHAVIOR.conversationSummary.maxSourceMessageChars,
      maxSummaryChars: CHAT_BEHAVIOR.conversationSummary.maxSummaryChars,
      ...config,
    };
  }

  async refresh(input: { workspaceId: string; conversationId: string; accountId?: string }): Promise<void> {
    const startedAt = Date.now();
    try {
      const messageCount = await this.messages.countByConversationId(input.workspaceId, input.conversationId);
      if (messageCount < this.config.minMessages) {
        this.logger?.debug(
          {
            event: "conversation_summary_skipped",
            reason: "below_threshold",
            conversationId: input.conversationId,
            messageCount,
          },
          "Skipped conversation summary regeneration",
        );
        return;
      }

      const [previous, tail] = await Promise.all([
        this.store.load({ sessionId: input.conversationId }),
        this.messages.listRecentByConversationId(
          input.workspaceId,
          input.conversationId,
          this.config.maxSourceMessages,
        ),
      ]);
      // Debounce: uncovered messages up to the recent-window size are still visible
      // verbatim alongside the summary, so regenerating every turn buys nothing.
      // refreshEveryMessages must stay below the recent-window size or a coverage
      // gap opens between the watermark and the window (enforced by a config test).
      if (previous && messageCount - previous.coveredMessageCount < this.config.refreshEveryMessages) {
        this.logger?.debug(
          {
            event: "conversation_summary_skipped",
            reason: "within_refresh_interval",
            conversationId: input.conversationId,
            uncoveredMessages: messageCount - previous.coveredMessageCount,
          },
          "Skipped conversation summary regeneration",
        );
        return;
      }
      // Gate on the same population that gets summarized: system rows count toward
      // the cheap threshold query above but are filtered out of the input. Only
      // meaningful when the tail holds the whole conversation — a truncated tail
      // already proves the conversation outgrew the window.
      const conversationMessages = tail.filter((message) => message.role !== "system");
      const tailTruncated = tail.length >= this.config.maxSourceMessages;
      if (conversationMessages.length === 0 || (!tailTruncated && conversationMessages.length < this.config.minMessages)) {
        this.logger?.debug(
          {
            event: "conversation_summary_skipped",
            reason: "below_conversational_threshold",
            conversationId: input.conversationId,
            conversationalMessageCount: conversationMessages.length,
          },
          "Skipped conversation summary regeneration",
        );
        return;
      }

      const prompt = this.buildPrompt(previous, conversationMessages);
      const generated = await this.generator.generate({
        prompt,
        usageContext: {
          workspaceId: input.workspaceId,
          accountId: input.accountId ?? null,
          conversationId: input.conversationId,
          messageId: null,
          surface: "assistant",
          operation: "conversation_summary",
          // The covered message count makes the usage-ledger idempotency key unique
          // per regeneration (a fixed key would dedupe every call after the first)
          // while keeping true retries of the same coverage idempotent.
          attemptKey: `conversation_summary:${input.conversationId}:${messageCount}`,
        },
      });
      const summary = clampSummary(generated, this.config.maxSummaryChars);
      if (!summary) {
        this.logger?.debug(
          {
            event: "conversation_summary_skipped",
            reason: "empty_generation",
            conversationId: input.conversationId,
          },
          "Skipped conversation summary regeneration",
        );
        return;
      }

      const record: ConversationSummaryRecord = {
        summary,
        coveredMessageCount: messageCount,
        coveredThrough: tail.at(-1)?.createdAt ?? new Date(),
      };
      await this.store.save({ sessionId: input.conversationId, summary: record });

      this.logger?.debug(
        {
          event: "conversation_summary_regenerated",
          conversationId: input.conversationId,
          durationMs: Date.now() - startedAt,
          sourceMessageCount: conversationMessages.length,
          summaryChars: summary.length,
        },
        "Regenerated conversation summary",
      );
    } catch (error) {
      // Best-effort: a failure here only means the next turn regenerates from
      // current state (the summary self-heals), so it must never fail the turn.
      // Name/message only: provider errors carry raw response bodies (which can
      // echo credentials), and this logger applies no redaction to custom keys.
      this.logger?.warn(
        {
          event: "conversation_summary_generation_failed",
          conversationId: input.conversationId,
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : undefined,
        },
        "Failed to regenerate conversation summary",
      );
    }
  }

  private buildPrompt(
    previous: ConversationSummaryRecord | null,
    messages: MessageRecord[],
  ): string {
    const previousSummarySection = previous?.summary.trim() ?? "";
    const conversationExcerpt = messages
      .map((message) => `${message.role.toUpperCase()}: ${clampExcerpt(message.content, this.config.maxSourceMessageChars)}`)
      .join("\n");
    return renderPromptTemplate("chat/conversation-summary.md", {
      max_summary_chars: String(this.config.maxSummaryChars),
      previous_summary_section: previousSummarySection,
      conversation_excerpt: conversationExcerpt,
    });
  }
}

/** Wraps the shared inference pipeline as a {@link ConversationSummaryGenerator}. */
export class ModelConversationSummaryGenerator implements ConversationSummaryGenerator {
  constructor(
    private readonly inference: ModelInferencePipeline,
    private readonly config: ConversationSummaryGenerationConfig = CHAT_BEHAVIOR.conversationSummary,
  ) {}

  async generate(input: { prompt: string; usageContext: ModelCallUsageContext }): Promise<string> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      prompt: input.prompt,
      reasoningEffort: this.config.reasoningEffort,
      maxOutputTokens: this.config.maxOutputTokens,
    });
    return text ?? "";
  }
}
