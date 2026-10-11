import { randomUUID } from "node:crypto";

import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../../db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../../db/repositories/messageRepository.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import { NoopActionDrainDispatcher, type ActionDrainDispatcherPort } from "../../../modules/chat/composition.js";
import type { ConversationActivityRecorder } from "../../../modules/conversationActivity/contracts/index.js";
import { bindDeliveryFailureRecorder, ConversationDeliveryFailureRepository } from "../../../modules/customerReplyDelivery/public.js";
import {
  EmailDeliveryFailureResolver,
  EmailDomainRepository,
  EmailMailboxRepository,
  EmailSendActionHandler,
  EmailSendIntentRepository,
  EmailThreadRepository,
  ProviderDeliveryEvents,
  ProviderSendAttempt,
  SendCommitment,
  SendIntentWriter,
  SendReconciler,
  type DeliveryResolutionUnitOfWork,
  type EmailChannelDrainDispatcherPort,
  type EmailSendCommitmentUnitOfWork,
  type EmailSendUnitOfWork,
} from "../../../modules/emailChannel/public.js";
import { HeldReplyService, type HeldReplyDispatchPort } from "../../../modules/handoff/public.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { pushActionDrainAfterCommit, type QueuedOutboxRow } from "../actionDrainAfterCommit.js";
import { runTransactionWithDeadlockRetry } from "../conversationLockOrder.js";
import { createPostgresDeliveryFailures } from "../deliveryFailures.js";
import { createPostgresHeldReplyUnitOfWork, type HeldReplyChannelRegistration } from "../heldReplyUnitOfWork.js";
import { channelEmailDriver, type ChannelProvider } from "./adapters.js";

/**
 * The send path (research B6, B18): the action handler, the reconciler and the provider-event
 * processor, sharing one channel driver and one fenced writer whose unit of work binds the
 * transition, its delivery failure and its thread index rows to one transaction.
 */
export const createEmailSendServices = (input: {
  provider: ChannelProvider;
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  drains: EmailChannelDrainDispatcherPort;
  heldReplyDispatch: Pick<HeldReplyDispatchPort, "materializeAuto">;
  audit: Pick<AuditPort, "record">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
  clock: () => Date;
}) => {
  const { provider, db, metrics, logger, clock } = input;
  const driver = channelEmailDriver(provider);
  const intents = new EmailSendIntentRepository(db);
  const mailboxes = new EmailMailboxRepository(db);
  const domains = new EmailDomainRepository(db);
  const unitOfWork = createPostgresEmailSendUnitOfWork({ db, activity: input.activity });
  const ownership = new ConversationOwnershipRepository(db);
  const writer = new SendIntentWriter({ unitOfWork, metrics, logger });
  const attempt = new ProviderSendAttempt({ driver, writer, unitOfWork, drains: input.drains, metrics, logger, clock });
  return {
    intents,
    handler: new EmailSendActionHandler({
      intents,
      unitOfWork,
      commitment: new SendCommitment({ unitOfWork: createPostgresEmailSendCommitmentUnitOfWork({ db, logger }) }),
      messages: new MessageRepository(db),
      mailboxes,
      domains,
      ownership,
      heldReplies: input.heldReplyDispatch,
      attempt,
      writer,
      failures: createPostgresDeliveryFailures({ db, activity: input.activity }),
      provider: provider.kind,
      metrics,
      logger,
      createId: randomUUID,
    }),
    reconciler: new SendReconciler({ intents, mailboxes, domains, ownership, driver, attempt, writer, metrics, logger }),
    deliveryEvents: new ProviderDeliveryEvents({ intents, writer, audit: input.audit, metrics, logger }),
  };
};

/**
 * The `email.send` handler as the worker builds it, with its own database, metrics and audit sink.
 * The worker builds it before the application's held-reply service, so it materializes automatic
 * replies through a held-reply dispatch of its own.
 */
export const createWorkerEmailSendHandler = (input: {
  provider: ChannelProvider;
  heldReplyChannel: HeldReplyChannelRegistration;
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  drains: EmailChannelDrainDispatcherPort;
  audit: Pick<AuditPort, "record">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
  errorReporter?: Pick<ErrorReporter, "report">;
  publisher: WorkspaceInvalidationPublisher;
}): EmailSendActionHandler => createEmailSendServices({
  provider: input.provider,
  db: input.db,
  activity: input.activity,
  drains: input.drains,
  heldReplyDispatch: createHeldReplyDispatch(input),
  audit: input.audit,
  metrics: input.metrics,
  logger: input.logger,
  clock: () => new Date(),
}).handler;

/**
 * The held-reply dispatch port the worker's `email.send` handler materializes automatic replies
 * through (research B9), over Postgres. Materializing writes the agent's message and its send
 * intent and queues nothing, so the teammate-facing ports a release needs are refused, and no
 * drain is pushed.
 */
const createHeldReplyDispatch = (deps: {
  heldReplyChannel: HeldReplyChannelRegistration;
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  audit: Pick<AuditPort, "record">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
  errorReporter?: Pick<ErrorReporter, "report">;
  /** Tells the dashboard of a reply the dispatch returned to a teammate, or sent. */
  publisher: WorkspaceInvalidationPublisher;
}): Pick<HeldReplyDispatchPort, "materializeAuto"> => {
  const notOnTheDispatchPath = (): never => {
    throw new Error("held_reply_dispatch_releases_nothing");
  };
  const service = new HeldReplyService({
    conversations: new ConversationRepository(deps.db),
    writes: createPostgresHeldReplyUnitOfWork({
      db: deps.db,
      channels: [deps.heldReplyChannel],
      activity: deps.activity,
      actionDrain: new NoopActionDrainDispatcher(),
      logger: deps.logger,
      errorReporter: deps.errorReporter,
    }),
    reads: new HeldReplyRepository(deps.db),
    operatorIdentities: { resolve: notOnTheDispatchPath },
    customerReplyDelivery: { route: notOnTheDispatchPath },
    replies: { write: notOnTheDispatchPath, announce: notOnTheDispatchPath },
    audit: deps.audit,
    publisher: deps.publisher,
    metrics: deps.metrics,
    logger: deps.logger,
    errorReporter: deps.errorReporter,
  });
  return { materializeAuto: (heldReplyId) => service.materializeAuto(heldReplyId) };
};

/**
 * The email half of a teammate's decision on a failed reply: mark it sent, or resend it, through
 * a unit of work that binds the decision to one transaction.
 */
export const createEmailDeliveryFailureResolver = (deps: {
  db: Kysely<DB>;
  intents: EmailSendIntentRepository;
  mailboxes: EmailMailboxRepository;
  domains: EmailDomainRepository;
  ownership: { versionOf(conversationId: string): Promise<number> };
  activity: ConversationActivityRecorder;
  actionDrain: ActionDrainDispatcherPort;
  errorReporter?: Pick<ErrorReporter, "report">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
}): EmailDeliveryFailureResolver => new EmailDeliveryFailureResolver({
  intents: deps.intents,
  mailboxes: deps.mailboxes,
  domains: deps.domains,
  ownership: deps.ownership,
  unitOfWork: createPostgresDeliveryResolutionUnitOfWork(deps),
  metrics: deps.metrics,
});

/**
 * Binds one send-intent change to one Postgres transaction: the fenced transition, the delivery
 * failure it raises, retargets or clears with its activity, and the thread index rows and budget
 * renewal it implies. Only binds; what is written is the send path's decision.
 */
export const createPostgresEmailSendUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
}): EmailSendUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({
    intents: new EmailSendIntentRepository(trx),
    threads: new EmailThreadRepository(trx),
    failures: bindDeliveryFailureRecorder({
      failures: new ConversationDeliveryFailureRepository(trx),
      activity: { record: (event) => deps.activity.record(trx, event) },
    }),
  })),
});

/**
 * Binds a send's commitment — its authority check and its freeze — to one Postgres transaction.
 * The commitment takes its locks in the conversation lock protocol's order
 * (`conversationLockOrder.ts`); an automatic send's first two steps lock the conversation row, then
 * its ownership row. A deadlock victim's whole transaction runs again. Only binds; what is checked
 * is the send path's decision.
 */
export const createPostgresEmailSendCommitmentUnitOfWork = (deps: {
  db: Kysely<DB>;
  /** Where a deadlock victim's retry is logged, by unit and attempt. */
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}): EmailSendCommitmentUnitOfWork => ({
  run: (work) => runTransactionWithDeadlockRetry(deps.db, (trx) => {
    const ownership = new ConversationOwnershipRepository(trx);
    return work({
      conversations: {
        lockOwnership: async ({ workspaceId, conversationId }) => {
          await new ConversationRepository(trx).lockForUpdate(conversationId, workspaceId);
          return ownership.loadForUpdate(conversationId);
        },
      },
      mailboxes: new EmailMailboxRepository(trx),
      domains: new EmailDomainRepository(trx),
      threads: new EmailThreadRepository(trx),
      messages: new MessageRepository(trx),
      intents: new EmailSendIntentRepository(trx),
    });
  }, { unit: "email_send_commitment", logger: deps.logger }),
});

/**
 * Binds a teammate's resolution to one Postgres transaction: the send intent's operator-resolution
 * transition, the failure it clears with its activity, and a resend's outbox row. The action drain
 * is pushed only after commit, when a resend was queued, and is best-effort.
 */
const createPostgresDeliveryResolutionUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  actionDrain: ActionDrainDispatcherPort;
  errorReporter?: Pick<ErrorReporter, "report">;
  logger: Pick<AppLogger, "warn">;
}): DeliveryResolutionUnitOfWork => ({
  async run(work) {
    let queued: QueuedOutboxRow | null = null;
    const result = await deps.db.transaction().execute((trx) => {
      const outbox = new ActionRequestRepository(trx);
      return work({
        intents: new EmailSendIntentRepository(trx),
        failures: bindDeliveryFailureRecorder({
          failures: new ConversationDeliveryFailureRepository(trx),
          activity: { record: (event) => deps.activity.record(trx, event) },
        }),
        outbox: {
          enqueue: async (request) => {
            const enqueued = await outbox.enqueue(request);
            queued = request;
            return enqueued;
          },
        },
      });
    });
    if (queued) await pushActionDrainAfterCommit(deps, "email_delivery_resend_drain_push_failed", queued);
    return result;
  },
});
