import { z } from "zod";

import type { JsonSchemaResponseFormat } from "../../../../shared/infra/llm/providerTypes.js";
import { traceOperation } from "../../../../shared/observability/tracing/operations.js";
import {
  askStructured,
  boundText,
  errorName,
  promptWithInput,
  readRevision,
  subjectIds,
  type EmailReviewCheckDependencies,
  type EmailReviewSubject,
} from "./emailReviewChecks.js";

const REPLY_NEEDED = ["yes", "no", "unsure"] as const;

/** What `email-reply-needed.md` returns: whether the customer's unanswered mail calls for a reply. */
export type ReplyNeeded = typeof REPLY_NEEDED[number];

/** The triage's verdict: the model's answer, or `unavailable` when none could be had. Only `no` silences. */
export type ReplyTriageVerdict = ReplyNeeded | "unavailable";

export interface EmailReplyTriagePort {
  /**
   * Whether the revision's unanswered customer mail calls for a reply at all. Never throws: a
   * failure, a timeout or nothing to judge is `unavailable`, which runs the review as before.
   */
  assess(subject: EmailReviewSubject): Promise<ReplyTriageVerdict>;
}

const PROMPT = "email-reply-needed.md";
const INPUT_TAG = "email-reply-needed-input";
/** The messages before the revision the model sees: enough to tell whether they were answered. */
const EARLIER_MESSAGES = 6;

const RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "email_reply_needed",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply_needed"],
    properties: { reply_needed: { type: "string", enum: [...REPLY_NEEDED] } },
  },
};

const verdictSchema = z.object({ reply_needed: z.enum(REPLY_NEEDED) }).strict();

/**
 * The reply triage (FR-017a): before a review turn, one structured call asks whether the customer's
 * mail since the business last wrote calls for a reply, given the exchange before it. It fails open:
 * anything but a clear `no` runs the review as before, so a model error never silences mail.
 */
export class ModelEmailReplyTriage implements EmailReplyTriagePort {
  constructor(private readonly deps: EmailReviewCheckDependencies) {}

  async assess(subject: EmailReviewSubject): Promise<ReplyTriageVerdict> {
    let verdict: ReplyTriageVerdict;
    try {
      verdict = await traceOperation({
        name: "email.review.reply_triage",
        attributes: { "radioso.workspace_id": subject.workspaceId, "radioso.conversation_id": subject.conversationId },
        run: () => this.ask(subject),
        resultAttributes: (result) => ({ verdict: result }),
      });
    } catch (error) {
      verdict = "unavailable";
      this.deps.logger.warn({ ...subjectIds(subject), errorName: errorName(error) }, "email_reply_triage_failed");
    }
    this.deps.metrics?.incrementCounter("email_reply_triage_total", {
      help: "Email reply triage verdicts before a review turn, by verdict.",
      labels: { verdict },
    });
    this.deps.logger.info({ ...subjectIds(subject), verdict }, "email_reply_triaged");
    return verdict;
  }

  private async ask(subject: EmailReviewSubject): Promise<ReplyTriageVerdict> {
    const { earlier, incoming } = await readRevision(this.deps.transcript, subject);
    // Nothing unanswered from the customer: there is nothing to judge, so the review decides.
    if (incoming.length === 0) return "unavailable";
    return askStructured({
      deps: this.deps,
      subject,
      operation: "email_reply_triage",
      prompt: promptWithInput(PROMPT, INPUT_TAG, {
        earlier: earlier.slice(-EARLIER_MESSAGES).map((message) => ({ author: message.author, text: boundText(message.text) })),
        incoming: incoming.map(boundText),
      }),
      responseFormat: RESPONSE_FORMAT,
      parse: (value) => verdictSchema.parse(value).reply_needed,
    });
  }
}
