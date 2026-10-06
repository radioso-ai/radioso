import type { DeliveryFailureRecorderPort } from "../../customerReplyDelivery/public.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { EmailChannelLogger } from "../emailChannelAudit.js";
import type {
  EmailSendIntentRecord,
  EmailSendIntentRepository,
  SendIntentTransitionOutcome,
} from "../persistence/emailSendIntentRepository.js";
import type { EmailThreadRepository } from "../persistence/emailThreadRepository.js";
import type { SendIntentEffect, SendIntentEvent, SendIntentState } from "./sendIntentTransitions.js";

/** The delivering channel's name on the failures it raises, as registered in the reply dispatcher. */
export const EMAIL_DELIVERY_PROVIDER = "email";

/** Lost races one event is re-applied through before the writer gives up (research B18). */
const MAX_FENCE_ATTEMPTS = 5;

/** Who applies an event; labels the fence-conflict counter (contracts/events.md). */
export type SendIntentWriterName = "handler" | "webhook" | "reconciler" | "operator";

/**
 * One send-intent change and what it causes, bound to one transaction by composition: the fenced
 * transition, the delivery failure it raises or settles, and the thread index rows an acceptance
 * records. All commit together, or none does.
 */
export interface EmailSendScope {
  intents: Pick<EmailSendIntentRepository, "materialize" | "transition" | "recordDeliveredMessageId" | "listMessagesSentThrough">;
  threads: Pick<EmailThreadRepository, "insertIndexEntries" | "renewSendBudget">;
  failures: DeliveryFailureRecorderPort;
}

export interface EmailSendUnitOfWork {
  run<T>(work: (scope: EmailSendScope) => Promise<T>): Promise<T>;
}

type Applied = Extract<SendIntentTransitionOutcome, { outcome: "applied" }>;

/** How a writer's event landed. `previousState` is the state the event was finally applied to. */
type SendIntentWriteOutcome =
  | (Applied & { previousState: SendIntentState })
  | Exclude<SendIntentTransitionOutcome, { outcome: "applied" | "conflict" }>;

/** Counts an intent entering its current state (contracts/events.md). */
export const countEmailSendIntentState = (
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null | undefined,
  intent: Pick<EmailSendIntentRecord, "trigger" | "state">,
): void => {
  metrics?.incrementCounter("email_send_intents_total", {
    help: "Email send intents entering each state, by trigger.",
    labels: { trigger: intent.trigger, state: intent.state },
  });
};

/**
 * Applies one event to a send intent through the repository's version fence (research B18). A
 * lost race re-applies the event to the intent as it now is, which the state machine judges on
 * that row: a terminal intent drops it, and an unsent settlement read before another claim froze
 * the request no longer applies. A transition's delivery-failure effects commit in its
 * transaction. `create_resend_intent` is left to the caller that asked for the resend: it is the
 * operator resolution's to act on.
 */
export class SendIntentWriter {
  constructor(private readonly deps: {
    unitOfWork: EmailSendUnitOfWork;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger: EmailChannelLogger;
  }) {}

  async apply(
    intent: EmailSendIntentRecord,
    event: SendIntentEvent,
    options: {
      writer: SendIntentWriterName;
      /** Further writes the applied change implies, in its transaction. */
      onApplied?: (scope: EmailSendScope, applied: EmailSendIntentRecord) => Promise<void>;
    },
  ): Promise<SendIntentWriteOutcome> {
    let expectedVersion = intent.version;
    let previousState = intent.state;
    for (let attempt = 1; attempt <= MAX_FENCE_ATTEMPTS; attempt += 1) {
      const result = await this.deps.unitOfWork.run(async (scope) => {
        const transition = await scope.intents.transition(intent.id, expectedVersion, event);
        if (transition.outcome === "applied") {
          await applyFailureEffects(scope, transition);
          await options.onApplied?.(scope, transition.intent);
        }
        return transition;
      });
      if (result.outcome === "applied") {
        this.observe(previousState, result.intent);
        return { ...result, previousState };
      }
      if (result.outcome !== "conflict") return result;
      this.deps.metrics?.incrementCounter("email_send_transition_conflicts_total", {
        help: "Send-intent transitions re-applied after losing the version fence, by writer.",
        labels: { writer: options.writer },
      });
      // Re-applied to the row as it is now, never to the one the writer read.
      expectedVersion = result.current.version;
      previousState = result.current.state;
    }
    throw new Error("email_send_transition_contended");
  }

  private observe(previousState: SendIntentState, after: EmailSendIntentRecord): void {
    if (after.state === previousState) return;
    countEmailSendIntentState(this.deps.metrics, after);
    const ids = { sendIntentId: after.id, conversationId: after.conversationId, workspaceId: after.workspaceId };
    if (after.state === "halted") this.deps.logger.warn({ ...ids, haltReason: after.haltReason }, "email_send_halted");
    if (after.state === "uncertain") this.deps.logger.warn({ ...ids, from: previousState }, "email_send_uncertain");
  }
}

const applyFailureEffects = async (scope: Pick<EmailSendScope, "intents" | "failures">, applied: Applied): Promise<void> => {
  const { intent } = applied;
  for (const effect of applied.effects) await applyFailureEffect(scope, intent, effect);
};

const applyFailureEffect = async (
  scope: Pick<EmailSendScope, "intents" | "failures">,
  intent: EmailSendIntentRecord,
  effect: SendIntentEffect,
): Promise<void> => {
  const { failures } = scope;
  switch (effect.kind) {
    case "open_delivery_failure":
      await failures.open({
        workspaceId: intent.workspaceId,
        conversationId: intent.conversationId,
        messageId: intent.messageId,
        provider: EMAIL_DELIVERY_PROVIDER,
        kind: effect.failureKind,
        detailCode: effect.detailCode,
      });
      return;
    case "retarget_delivery_failure":
      // Only an attempt whose own failure is still open asks for this: the machine never retargets
      // from an attempt a teammate resent, whose message's failure is the resend's.
      await failures.retarget({
        conversationId: intent.conversationId,
        messageId: intent.messageId,
        kind: effect.failureKind,
        detailCode: effect.detailCode,
      });
      return;
    case "clear_delivery_failure":
      switch (effect.reason) {
        case "provider_evidence":
          await failures.clear({ reason: effect.reason, conversationId: intent.conversationId, messageIds: [intent.messageId] });
          return;
        case "later_delivery":
          // Every earlier reply this delivery vouches for; a newer send's failure stands.
          await failures.clear({
            reason: effect.reason,
            conversationId: intent.conversationId,
            messageIds: await scope.intents.listMessagesSentThrough(intent),
          });
          return;
        case "operator_resolved":
          // The resolution clears the failure the teammate decided on, by its id, in its own unit.
          throw new Error("An operator resolution clears its failure through the delivery-failure resolver.");
      }
      return;
    // The repository turns a schedule into `next_reconcile_at`; a resend is the resolver's.
    case "schedule_reconcile":
    case "create_resend_intent":
      return;
  }
};
