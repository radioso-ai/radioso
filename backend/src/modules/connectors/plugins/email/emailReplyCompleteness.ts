import type { ConnectorReplyDraft, ConnectorTurnFacts } from "@radioso/connector-api";
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

const COMPLETENESS = ["complete", "partial", "not_answered"] as const;

/**
 * Whether a reply answers everything the customer asked: what `email-reply-completeness.md` returns,
 * or `unavailable` when no verdict could be had. Only `complete` lets a reply publish.
 */
export type ReplyCompleteness = typeof COMPLETENESS[number] | "unavailable";

export interface ReplyCompletenessResult {
  completeness: ReplyCompleteness;
  /** How many of the customer's asks the reply leaves unanswered; null when no verdict was had. */
  unansweredAsks: number | null;
}

/** The passages a review turn drew on, as the host recorded them on its draft. */
export interface EmailReviewGroundingReader {
  passagesFor(input: { workspaceId: string; draft: ConnectorReplyDraft }): Promise<readonly { title: string; text: string }[]>;
}

export interface EmailReplyCompletenessPort {
  /**
   * Whether `draft` answers everything the revision's customer mail asks. Never throws: a failure,
   * a timeout or nothing to judge is `unavailable`, which holds the reply.
   */
  assess(input: EmailReviewSubject & { draft: ConnectorReplyDraft }): Promise<ReplyCompletenessResult>;
}

const PROMPT = "email-reply-completeness.md";
const INPUT_TAG = "email-reply-completeness-input";
/** The passages the model sees, most relevant first as the turn ranked them. */
const MAX_PASSAGES = 12;
/** A schema bound on the count, not a product limit. */
const MAX_UNANSWERED_ASKS = 50;

const RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "email_reply_completeness",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["completeness", "unanswered_asks"],
    properties: {
      completeness: { type: "string", enum: [...COMPLETENESS] },
      unanswered_asks: { type: "integer", minimum: 0, maximum: MAX_UNANSWERED_ASKS },
    },
  },
};

const verdictSchema = z.object({
  completeness: z.enum(COMPLETENESS),
  unanswered_asks: z.number().int().min(0).max(MAX_UNANSWERED_ASKS),
}).strict();

const UNAVAILABLE: ReplyCompletenessResult = { completeness: "unavailable", unansweredAsks: null };

/** The coverage a held reply shows for an incomplete verdict, so a teammate reads why it waits. */
const COVERAGE_OF_INCOMPLETE: Record<Exclude<ReplyCompleteness, "complete">, ConnectorTurnFacts["coverage"]> = {
  partial: "partial",
  not_answered: "unanswered",
  unavailable: "unavailable",
};

/**
 * The turn's facts with the completeness verdict in place of the turn's own coverage when the
 * verdict says the reply is not complete: the email check read the reply the coverage verdict did not.
 */
export const factsWithCompleteness = (facts: ConnectorTurnFacts, completeness: ReplyCompleteness | null): ConnectorTurnFacts =>
  completeness === null || completeness === "complete" ? facts : { ...facts, coverage: COVERAGE_OF_INCOMPLETE[completeness] };

/**
 * The completeness check (FR-020): before an automatic send, one structured call reads the
 * customer's unanswered mail, the candidate reply and the passages its turn drew on, and says
 * whether the reply answers every ask. It fails closed: anything but `complete` holds the reply.
 */
export class ModelEmailReplyCompleteness implements EmailReplyCompletenessPort {
  constructor(private readonly deps: EmailReviewCheckDependencies & { grounding: EmailReviewGroundingReader }) {}

  async assess(input: EmailReviewSubject & { draft: ConnectorReplyDraft }): Promise<ReplyCompletenessResult> {
    const { draft, ...subject } = input;
    let result: ReplyCompletenessResult;
    try {
      result = await traceOperation({
        name: "email.review.completeness",
        attributes: { "radioso.workspace_id": subject.workspaceId, "radioso.conversation_id": subject.conversationId },
        run: () => this.ask(subject, draft),
        resultAttributes: (checked) => ({ verdict: checked.completeness }),
      });
    } catch (error) {
      result = UNAVAILABLE;
      this.deps.logger.warn({ ...subjectIds(subject), errorName: errorName(error) }, "email_completeness_check_failed");
    }
    this.deps.metrics?.incrementCounter("email_completeness_checks_total", {
      help: "Completeness checks on automatic email replies, by verdict.",
      labels: { verdict: result.completeness },
    });
    this.deps.logger.info({ ...subjectIds(subject), verdict: result.completeness, unansweredAsks: result.unansweredAsks }, "email_completeness_checked");
    return result;
  }

  private async ask(subject: EmailReviewSubject, draft: ConnectorReplyDraft): Promise<ReplyCompletenessResult> {
    const [{ incoming }, passages] = await Promise.all([
      readRevision(this.deps.transcript, subject),
      this.deps.grounding.passagesFor({ workspaceId: subject.workspaceId, draft }),
    ]);
    // No customer mail to measure the reply against: no verdict, so the reply waits.
    if (incoming.length === 0) return UNAVAILABLE;
    return askStructured({
      deps: this.deps,
      subject,
      operation: "email_reply_completeness",
      prompt: promptWithInput(PROMPT, INPUT_TAG, {
        customer_messages: incoming.map(boundText),
        reply: boundText(draft.text),
        context: passages.slice(0, MAX_PASSAGES).map((passage) => ({ title: passage.title, text: boundText(passage.text) })),
      }),
      responseFormat: RESPONSE_FORMAT,
      parse: (value) => {
        const verdict = verdictSchema.parse(value);
        return { completeness: verdict.completeness, unansweredAsks: verdict.unanswered_asks };
      },
    });
  }
}
