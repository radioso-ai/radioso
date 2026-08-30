import { CHAT_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { JsonSchemaResponseFormat, ReasoningEffort } from "../../../../shared/infra/llm/providerTypes.js";
import type { ModelInferencePipeline } from "../../../../shared/infra/llm/modelInferencePipeline.js";
import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { ConversationRepositoryPort } from "../../../../db/repositories/conversationRepository.js";
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

/**
 * The narrow write slice the title regeneration needs. Deliberately not part of
 * {@link ConversationSummaryStore}: the title persists on `conversations` (see
 * migration 154), never on the expiring `conversation_summaries` row, so it is
 * written through the conversation repository instead of the summary store.
 */
export type ConversationSummaryTitleWriter = Pick<ConversationRepositoryPort, "setTitle">;

/** One regeneration's structured output: the rolling summary plus a short topic title. */
export interface ConversationSummaryGeneration {
  summary: string;
  /** Absent when the model omits it or returns a blank string — never an empty string. */
  title?: string;
}

/** Generates a fresh summary (and topic title) from the assembled prompt. Wraps the shared inference seam. */
export interface ConversationSummaryGenerator {
  generate(input: { prompt: string; usageContext: ModelCallUsageContext }): Promise<ConversationSummaryGeneration>;
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
  maxInitialBackfillMessages: number;
  maxSourceMessageChars: number;
  maxSummaryChars: number;
  maxTitleChars: number;
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

// Title-specific clamp: normalizes to a single line (a title is a row label, never
// multi-line) and treats a missing, blank, or whitespace-only value as absent rather
// than as an empty string, so a caller can `if (title)` without a second blank check.
const clampTitle = (value: string | undefined, maxLength: number): string | undefined => {
  if (!value) {
    return undefined;
  }
  const clamped = truncateWithEllipsis(normalizeWhitespace(value), maxLength);
  return clamped.length > 0 ? clamped : undefined;
};

/**
 * Regenerates (never appends) the rolling per-conversation summary (#866) off the
 * critical path after a turn completes. Below the message threshold the raw window
 * already carries the whole conversation, so it skips without an LLM call. Above it,
   * one LLM call rewrites the previous summary plus a bounded tail of recent messages
   * into a fresh, hard-clamped summary and upserts it under the watermark guard. The
   * first summary for a legacy long conversation may use a capped multi-call backfill
   * over recent history, never the unbounded full thread.
 *
 * The same regeneration call also returns a short topic title (issue #1114), written
 * to `conversations.title` right after a successful summary save. The title write is
 * best-effort and independent of the summary write: a title-write failure never
 * un-does or blocks the summary, and an absent/blank title (the model omitted it, or
 * it clamps to nothing) simply skips the write, leaving any previously stored title
 * in place.
 *
 * All observability here is content-free: it records durations, counts, and reasons,
 * never the summary text, title text, message content, or prompt.
 */
export class ConversationSummaryService implements ConversationSummaryUpdater {
  private readonly config: ConversationSummaryConfig;

  constructor(
    private readonly store: ConversationSummaryStore,
    private readonly messages: ConversationSummaryMessageReader,
    private readonly generator: ConversationSummaryGenerator,
    private readonly titleWriter: ConversationSummaryTitleWriter,
    private readonly logger?: Pick<AppLogger, "debug" | "warn">,
    config: Partial<ConversationSummaryConfig> = {},
  ) {
    this.config = {
      minMessages: CHAT_BEHAVIOR.conversationSummary.minMessages,
      refreshEveryMessages: CHAT_BEHAVIOR.conversationSummary.refreshEveryMessages,
      maxSourceMessages: CHAT_BEHAVIOR.conversationSummary.maxSourceMessages,
      maxInitialBackfillMessages: CHAT_BEHAVIOR.conversationSummary.maxInitialBackfillMessages,
      maxSourceMessageChars: CHAT_BEHAVIOR.conversationSummary.maxSourceMessageChars,
      maxSummaryChars: CHAT_BEHAVIOR.conversationSummary.maxSummaryChars,
      maxTitleChars: CHAT_BEHAVIOR.conversationSummary.maxTitleChars,
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
      if (!previous && tailTruncated) {
        await this.refreshFirstSummaryFromInitialBackfill(input, messageCount, startedAt);
        return;
      }
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
        usageContext: this.usageContext(input, messageCount),
      });
      const summary = clampSummary(generated.summary, this.config.maxSummaryChars);
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

      const title = clampTitle(generated.title, this.config.maxTitleChars);
      const titleWritten = title ? await this.persistTitle(input, title) : false;

      this.logger?.debug(
        {
          event: "conversation_summary_regenerated",
          conversationId: input.conversationId,
          durationMs: Date.now() - startedAt,
          sourceMessageCount: conversationMessages.length,
          summaryChars: summary.length,
          titleWritten,
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

  private async refreshFirstSummaryFromInitialBackfill(
    input: { workspaceId: string; conversationId: string; accountId?: string },
    messageCount: number,
    startedAt: number,
  ): Promise<void> {
    const allMessages = await this.messages.listRecentByConversationId(
      input.workspaceId,
      input.conversationId,
      Math.min(messageCount, this.config.maxInitialBackfillMessages),
    );
    const conversationMessages = allMessages.filter((message) => message.role !== "system");
    if (conversationMessages.length < this.config.minMessages) {
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

    let running: ConversationSummaryRecord | null = null;
    // The freshest chunk's title wins: later chunks see more of the conversation (they
    // are seeded by the running summary), so their title read is the most complete one.
    let latestTitle: string | undefined;
    for (let index = 0; index < conversationMessages.length; index += this.config.maxSourceMessages) {
      const chunk = conversationMessages.slice(index, index + this.config.maxSourceMessages);
      const generated = await this.generator.generate({
        prompt: this.buildPrompt(running, chunk),
        usageContext: this.usageContext(
          input,
          messageCount,
          `backfill:${Math.floor(index / this.config.maxSourceMessages)}`,
        ),
      });
      const summary = clampSummary(generated.summary, this.config.maxSummaryChars);
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
      latestTitle = clampTitle(generated.title, this.config.maxTitleChars) ?? latestTitle;
      running = {
        summary,
        // The first summary may intentionally use only a bounded recent backfill
        // window. Advance the watermark to the current count so a legacy long
        // conversation does not repeat the capped backfill on every turn.
        coveredMessageCount: messageCount,
        coveredThrough: chunk.at(-1)?.createdAt ?? allMessages.at(-1)?.createdAt ?? new Date(),
      };
    }

    if (!running) {
      return;
    }
    const record: ConversationSummaryRecord = {
      ...running,
      coveredMessageCount: messageCount,
      coveredThrough: allMessages.at(-1)?.createdAt ?? running.coveredThrough,
    };
    await this.store.save({ sessionId: input.conversationId, summary: record });

    const titleWritten = latestTitle ? await this.persistTitle(input, latestTitle) : false;

    this.logger?.debug(
      {
        event: "conversation_summary_regenerated",
        conversationId: input.conversationId,
        durationMs: Date.now() - startedAt,
        sourceMessageCount: conversationMessages.length,
        summaryChars: record.summary.length,
        titleWritten,
      },
      "Regenerated conversation summary",
    );
  }

  private usageContext(
    input: { workspaceId: string; conversationId: string; accountId?: string },
    coveredMessageCount: number,
    phase?: string,
  ): ModelCallUsageContext {
    return {
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      conversationId: input.conversationId,
      messageId: null,
      surface: "assistant",
      operation: "conversation_summary",
      // The covered message count makes the usage-ledger idempotency key unique
      // per regeneration (a fixed key would dedupe every call after the first)
      // while keeping true retries of the same coverage idempotent. Backfill chunks
      // add a stable phase because one regeneration can require multiple model calls.
      attemptKey: phase
        ? `conversation_summary:${input.conversationId}:${coveredMessageCount}:${phase}`
        : `conversation_summary:${input.conversationId}:${coveredMessageCount}`,
    };
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

  /**
   * Best-effort title write, isolated from summary persistence: the summary above has
   * already been saved by the time this runs, so a title-write failure must never read
   * as a failed regeneration (the outer catch's `conversation_summary_generation_failed`
   * event) or retry the summary call. Returns whether the write happened, for the
   * content-free regeneration log.
   */
  private async persistTitle(
    input: { workspaceId: string; conversationId: string },
    title: string,
  ): Promise<boolean> {
    try {
      await this.titleWriter.setTitle(input.conversationId, input.workspaceId, title);
      return true;
    } catch (error) {
      this.logger?.warn(
        {
          event: "conversation_title_write_failed",
          conversationId: input.conversationId,
          errorType: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : undefined,
        },
        "Failed to persist conversation title",
      );
      return false;
    }
  }
}

/**
 * Strict JSON-schema shape the regeneration call returns: the rolling summary plus a
 * short topic title, in one response so persisting a title never costs a second LLM
 * call. `title` still allows an empty string (rather than making it fully optional in
 * the schema) so a provider without true "optional in strict mode" support has a legal
 * value to emit when it has nothing better than the previous title.
 */
const CONVERSATION_SUMMARY_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "conversation_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "title"],
    properties: {
      summary: { type: "string" },
      title: { type: "string" },
    },
  },
};

const parseConversationSummaryGeneration = (raw: string): ConversationSummaryGeneration => {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Conversation summary model response was not a JSON object");
  }
  const { summary, title } = parsed as { summary?: unknown; title?: unknown };
  if (typeof summary !== "string") {
    throw new Error("Conversation summary model response was missing a summary string");
  }
  return {
    summary,
    // A wrong-typed title degrades to absent rather than failing the whole
    // regeneration — the summary is the load-bearing half of this call.
    title: typeof title === "string" ? title : undefined,
  };
};

/** Wraps the shared inference pipeline as a {@link ConversationSummaryGenerator}. */
export class ModelConversationSummaryGenerator implements ConversationSummaryGenerator {
  constructor(
    private readonly inference: ModelInferencePipeline,
    private readonly config: ConversationSummaryGenerationConfig = CHAT_BEHAVIOR.conversationSummary,
  ) {}

  async generate(input: { prompt: string; usageContext: ModelCallUsageContext }): Promise<ConversationSummaryGeneration> {
    const { text } = await this.inference.complete({
      operation: input.usageContext,
      prompt: input.prompt,
      reasoningEffort: this.config.reasoningEffort,
      maxOutputTokens: this.config.maxOutputTokens,
      responseFormat: CONVERSATION_SUMMARY_RESPONSE_FORMAT,
      validateResult: (result) => {
        parseConversationSummaryGeneration(result.text ?? "");
      },
    });
    return parseConversationSummaryGeneration(text ?? "");
  }
}
