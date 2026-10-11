import type { ModelCallUsageContext } from "../../../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../../../shared/infra/llm/modelInferencePipeline.js";
import type { JsonSchemaResponseFormat } from "../../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";

/**
 * What the email review's model checks share (the reply triage before a turn, the completeness
 * check before an automatic send): the revision they judge, the conversation as they read it, and
 * one bounded structured model call. Each check owns its prompt, its verdict and its fail-safe
 * direction; this file knows none of them.
 */

/** The review a check runs for, for model-usage attribution and logs: ids and counters only. */
export interface EmailReviewSubject {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  revision: number;
  /** The review's claim attempt: a retried review is a new model call. */
  attempt: number;
}

/**
 * Workspace-scoped structured inference, narrowed to what the checks call. Composition hands in the
 * same provider plumbing the review turn resolves through, and picks its tier.
 */
export interface EmailReviewInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string };
    modelCallContext: ModelCallUsageContext;
  }): Promise<Pick<ModelInferencePipeline, "complete">>;
}

/** One message of the conversation as a check reads it: who wrote it, and its text. */
export interface EmailTranscriptMessage {
  author: "customer" | "business";
  text: string;
}

export interface EmailReviewTranscriptReader {
  /**
   * The conversation's newest messages, oldest first, at most `limit`, and fewer only when the
   * conversation has no more: the checks read a short result as the conversation's start. A held
   * draft is never one.
   */
  recentMessages(input: { workspaceId: string; conversationId: string; limit: number }): Promise<readonly EmailTranscriptMessage[]>;
}

/** The host's stored messages, narrowed to what the transcript reads. */
export interface EmailReviewMessageStore {
  /** The newest `limit` messages in `roles`, oldest first; the roles filter applies before the limit. */
  listRecentByConversationId(
    workspaceId: string,
    conversationId: string,
    limit: number,
    options: { roles: readonly TranscriptRole[] },
  ): Promise<readonly { role: string; content: string }[]>;
}

/**
 * The rows the checks read: the customer's messages and the business's, never a system row. The
 * store filters before it limits, so the window check sees truncation.
 */
const TRANSCRIPT_ROLES = ["user", "assistant"] as const;
type TranscriptRole = typeof TRANSCRIPT_ROLES[number];

/** The conversation as the checks read it, over the host's stored messages. */
export const emailReviewTranscript = (messages: EmailReviewMessageStore): EmailReviewTranscriptReader => ({
  recentMessages: async ({ workspaceId, conversationId, limit }) =>
    (await messages.listRecentByConversationId(workspaceId, conversationId, limit, { roles: TRANSCRIPT_ROLES }))
      .map((message) => ({ author: message.role === "user" ? "customer" : "business", text: message.content })),
});

/** What every check is built with. */
export interface EmailReviewCheckDependencies {
  inference: EmailReviewInferenceFactory;
  transcript: EmailReviewTranscriptReader;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  /** Ids, verdicts and error names only; never a message, a draft or a passage. */
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  /** How long a check waits for the model before it gives up; its verdict is then `unavailable`. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The messages a check reads: the revision's own, and enough before them to see what was answered. */
const TRANSCRIPT_WINDOW = 12;
/** Bounds one earlier message or passage in a prompt; email bodies and chunks can be long. A reply is never cut. */
const MAX_TEXT_CHARS = 4_000;
/**
 * The customer's unanswered mail a check reads whole. Mail past it cannot be judged completely in
 * one bounded call, so the check has no verdict rather than one about part of what was asked.
 */
const INCOMING_CHARS_BUDGET = 12_000;
/** Low hidden reasoning and a small JSON verdict. */
const MAX_OUTPUT_TOKENS = 1_024;

/**
 * The conversation split at the business's last message: `incoming` is the customer's mail since,
 * which this revision answers, and `earlier` is what came before it.
 */
const splitRevision = (messages: readonly EmailTranscriptMessage[]): { earlier: EmailTranscriptMessage[]; incoming: string[] } => {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.author === "customer") start -= 1;
  return { earlier: messages.slice(0, start), incoming: messages.slice(start).map((message) => message.text) };
};

/** Why the revision's unanswered mail could not be read whole: it began before the window, or ran past the budget. */
type OmittedInput = "transcript_window" | "input_budget";

/**
 * The revision's messages, read through the transcript port with the checks' window. `omitted`
 * says why the unanswered mail is not all there, and is logged; a check then gives no verdict.
 * One message more than the window is read, so a block that starts right at the window's edge is
 * told from one that runs past it.
 */
export const readRevision = async (
  deps: Pick<EmailReviewCheckDependencies, "transcript" | "logger">,
  subject: EmailReviewSubject,
): Promise<{ earlier: EmailTranscriptMessage[]; incoming: string[]; omitted: OmittedInput | null }> => {
  const read = await deps.transcript.recentMessages({
    workspaceId: subject.workspaceId,
    conversationId: subject.conversationId,
    limit: TRANSCRIPT_WINDOW + 1,
  });
  const window = read.slice(-TRANSCRIPT_WINDOW);
  const beforeWindow = read.length > TRANSCRIPT_WINDOW ? read[read.length - TRANSCRIPT_WINDOW - 1] : undefined;
  const { earlier, incoming } = splitRevision(window);
  const omitted = omittedInput(earlier, incoming, beforeWindow);
  if (omitted) deps.logger.warn({ ...subjectIds(subject), omitted }, "email_review_input_incomplete");
  return { earlier, incoming, omitted };
};

const omittedInput = (
  earlier: readonly EmailTranscriptMessage[],
  incoming: readonly string[],
  beforeWindow: EmailTranscriptMessage | undefined,
): OmittedInput | null => {
  // The block's start is in view when the business's last message is, or when nothing the customer wrote precedes the window.
  if (earlier.length === 0 && beforeWindow?.author === "customer") return "transcript_window";
  if (incoming.reduce((total, text) => total + text.length, 0) > INCOMING_CHARS_BUDGET) return "input_budget";
  return null;
};

export const boundText = (text: string): string => (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text);

const ENVELOPE_ESCAPES: Readonly<Record<string, string>> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };

/** The prompt file followed by the untrusted payload as JSON, escaped so it cannot close its envelope tag. */
export const promptWithInput = (templatePath: string, tag: string, payload: unknown): string =>
  `${loadPromptTemplate(templatePath)}\n\n<${tag}>\n${JSON.stringify(payload).replace(/[<>&]/g, (character) => ENVELOPE_ESCAPES[character] ?? character)}\n</${tag}>`;

const parseJson = <T>(text: string, parse: (value: unknown) => T): T => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("email_review_check_invalid_json");
  }
  return parse(value);
};

/**
 * One structured model call for a check: attributed to the email channel under `operation`,
 * bounded by the check's timeout, and validated by `parse`, which throws on anything outside the
 * schema. Throws on any failure; the check decides what a failure means.
 */
export const askStructured = async <T>(input: {
  deps: Pick<EmailReviewCheckDependencies, "inference" | "timeoutMs">;
  subject: EmailReviewSubject;
  operation: string;
  prompt: string;
  responseFormat: JsonSchemaResponseFormat;
  parse: (value: unknown) => T;
}): Promise<T> => {
  const { subject } = input;
  const modelCallContext: ModelCallUsageContext = {
    workspaceId: subject.workspaceId,
    agentId: subject.agentId,
    conversationId: subject.conversationId,
    surface: "email_channel",
    operation: input.operation,
    attemptKey: `email_review:${subject.revision}:${subject.attempt}`,
  };
  const inference = await input.deps.inference.create({ workspaceContext: { workspaceId: subject.workspaceId }, modelCallContext });
  const completion = await inference.complete({
    prompt: input.prompt,
    responseFormat: input.responseFormat,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    reasoningEffort: "low",
    signal: AbortSignal.timeout(input.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    operation: modelCallContext,
    validateResult: (result) => {
      parseJson(result.text, input.parse);
    },
  });
  return parseJson(completion.text, input.parse);
};

export const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

export const subjectIds = (subject: EmailReviewSubject): Record<string, unknown> => ({
  workspaceId: subject.workspaceId,
  conversationId: subject.conversationId,
  agentId: subject.agentId,
  revision: subject.revision,
  attempt: subject.attempt,
});
