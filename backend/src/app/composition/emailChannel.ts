import { randomBytes, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

import type { ConnectorChatPort, ConnectorPlugin } from "@radioso/connector-api";
import {
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { Kysely } from "kysely";

import type { Env, parseEmailChannelConfig } from "../config/env.js";
import { ActionRequestRepository } from "../../db/repositories/actionRequestRepository.js";
import { ChunkPassageRepository } from "../../db/repositories/chunkPassageRepository.js";
import { ConversationActivityRepository } from "../../db/repositories/conversationActivityRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import { MessageRepository, type MessageRecord } from "../../db/repositories/messageRepository.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { NoopActionDrainDispatcher, type ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import {
  EMAIL_COALESCE_SECONDS,
  EMAIL_RAW_MAX_BYTES,
  EMAIL_REVIEW_MAX_ATTEMPTS,
  createEmailChannelConnector,
  createEmailReviewChecks,
  type EmailChannelWorker,
  type EmailReviewChecks,
  type EmailReviewInferenceFactory,
  type EmailThreadProtocolUnitOfWork,
  type EmailTranscriptMessage,
} from "../../modules/connectors/plugins/index.js";
import { reviewDraftRetrievedChunkIds } from "../../modules/connectors/services/reviewDraftGrounding.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import {
  bindDeliveryFailureRecorder,
  ConversationDeliveryFailureRepository,
  DeliveryFailures,
  type CustomerChannelReplyDeliverer,
  type DeliveryFailureResolverPort,
  type DeliveryFailureUnitOfWork,
} from "../../modules/customerReplyDelivery/public.js";
import {
  ConversationEmailFactsReader,
  EMAIL_EVENT_RETENTION_DAYS,
  EMAIL_MAILBOX_POLICY_REF_PREFIX,
  EMAIL_SEND_ACTION_TYPE,
  EmailChannelCopilotView,
  EmailChannelSweep,
  EmailCustomerReplyDeliverer,
  EmailDeliveryFailureResolver,
  EmailDomainRepository,
  EmailHeldReplyChannelScope,
  EmailInboundRepository,
  EmailMailboxRepository,
  EmailSendActionHandler,
  EmailSendIntentRepository,
  EmailThreadRepository,
  EventLogReader,
  InboundEventActions,
  MailboxService,
  ProviderDeliveryEvents,
  ProviderSendAttempt,
  SendIntentWriter,
  SendReconciler,
  SendingDomainService,
  lockThreadResolution,
  type DeliveryResolutionUnitOfWork,
  type EmailChannelDrainDispatcherPort,
  type EmailSendUnitOfWork,
  type EngagementMode,
  type MailboxPolicyChangeUnitOfWork,
} from "../../modules/emailChannel/public.js";
import {
  HeldReplyService,
  type ConversationOwnershipService,
  type HeldReplyDispatchPort,
} from "../../modules/handoff/public.js";
import { LocalEmailDomainProvisioner } from "../../modules/mail/adapters/localDomainProvisioner.js";
import { LocalEmailDriver } from "../../modules/mail/adapters/localEmailDriver.js";
import { LocalInboundEmailReceiver } from "../../modules/mail/adapters/localInboundReceiver.js";
import { LOCAL_EMAIL_SPOOL_DIR } from "../../modules/mail/adapters/localSpool.js";
import { ResendApiClient } from "../../modules/mail/adapters/resendApi.js";
import { ResendEmailDomainProvisioner } from "../../modules/mail/adapters/resendDomainProvisioner.js";
import { ResendInboundEmailReceiver } from "../../modules/mail/adapters/resendInboundReceiver.js";
import { ResendEmailDriver, type EmailDomainProvisioner, type EmailDriver, type InboundEmailReceiver } from "../../modules/mail/public.js";
import type { ErrorReporter } from "../../shared/errors/errorReporter.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { pushActionDrainAfterCommit, type QueuedOutboxRow } from "./actionDrainAfterCommit.js";
import type { ApplicationModule } from "./applicationModule.js";
import { createPostgresHeldReplyUnitOfWork, type HeldReplyChannelRegistration } from "./heldReplyUnitOfWork.js";
import { createPostgresMailboxPolicyChangeUnitOfWork } from "./mailboxPolicyChange.js";

type EmailChannelConfig = NonNullable<ReturnType<typeof parseEmailChannelConfig>>;

/**
 * Overrides of the channel's fixed timings and limits and of the local provider's spool, for tests
 * and the behaviour harness. A deployment composes none: each falls back to the constant of the
 * module that owns it.
 */
export interface EmailChannelOptions {
  /** Mail on one thread inside it gets one review; `EMAIL_COALESCE_SECONDS` otherwise. */
  coalesceSeconds?: number;
  /** Raw MIME bytes stored per delivery; `EMAIL_RAW_MAX_BYTES` otherwise. */
  rawMaxBytes?: number;
  /** Days a conversation-less delivery is kept; `EMAIL_EVENT_RETENTION_DAYS` otherwise. */
  eventRetentionDays?: number;
  /** Claims a review gets before it goes to a person; `EMAIL_REVIEW_MAX_ATTEMPTS` otherwise. */
  reviewMaxAttempts?: number;
  /** Where the local provider spools mail; `LOCAL_EMAIL_SPOOL_DIR` otherwise. Resend ignores it. */
  localSpoolDir?: string;
}

/** The provider the channel's adapters are built for: Resend's account, or the local spool. */
type ChannelProvider =
  | Extract<EmailChannelConfig["provider"], { kind: "resend" }>
  | { kind: "local"; spoolDir: string };

const channelProviderOf = (config: EmailChannelConfig, options: EmailChannelOptions): ChannelProvider =>
  config.provider.kind === "resend"
    ? config.provider
    : { kind: "local", spoolDir: options.localSpoolDir ?? LOCAL_EMAIL_SPOOL_DIR };

/**
 * The engagement modes this deployment runs (plan, Questions settled, item 4): mail is handed to
 * people, the agent drafts a reply a teammate sends, or, on a mailbox an operator opted in, the
 * agent answers automatically when the publication decision allows (research B9). `draft` is the
 * default for new mailboxes; existing ones keep their mode. Without `auto` here, automatic sending
 * is not granted to the held-reply scope and the sweep returns queued sends to a teammate.
 */
const SUPPORTED_MODES: readonly EngagementMode[] = ["operator_only", "draft", "auto"];

export type { EmailReviewChecks };

/** What the operator surfaces call: the settings card, the event log and the inbox's email facts. */
export interface EmailChannelOperatorServices {
  /** The deployment's relay domain, shown in the settings overview. */
  inboundDomain: string;
  sendingDomains: SendingDomainService;
  mailboxes: MailboxService;
  eventLog: EventLogReader;
  inboundEvents: InboundEventActions;
  conversationFacts: ConversationEmailFactsReader;
}

interface EmailChannelComposition extends EmailChannelOperatorServices {
  supportedModes: readonly EngagementMode[];
  receiver: InboundEmailReceiver;
  provisioner: EmailDomainProvisioner;
  /** The provider webhook, registered with the built-in connectors. */
  plugin: ConnectorPlugin;
  /** Inbound drain and sweep, for the worker runtime's loop and the worker-task routes. */
  worker: EmailChannelWorker;
  /** Registered under `email` in the customer-reply dispatcher. */
  customerReplyDeliverer: CustomerChannelReplyDeliverer;
  policyChanges: MailboxPolicyChangeUnitOfWork;
  /** The token-free projection Ray's email channel tools read (ports §8). */
  copilotView: EmailChannelCopilotView;
  /** Email's side of held-reply transactions, registered with the held-reply unit of work. */
  heldReplyChannel: HeldReplyChannelRegistration;
  /** The email half of a teammate's decision on a failed reply: mark it sent, or resend it. */
  deliveryFailureResolver: DeliveryFailureResolverPort;
  /** The review's model checks (reply triage, completeness), which the review runner reads on each call. */
  reviewChecks: EmailReviewChecks;
}

interface EmailChannelCompositionInput {
  /** `parseEmailChannelConfig(env)`; undefined when no email provider is configured. */
  config: EmailChannelConfig | undefined;
  options?: EmailChannelOptions;
  db: Kysely<DB>;
  drains: EmailChannelDrainDispatcherPort;
  activity: ConversationActivityRecorder;
  /**
   * The host port: `ingest` records inbound mail, `respond` runs its review turn. Called only while
   * draining, after the application is built.
   */
  chat: Pick<ConnectorChatPort, "ingest" | "respond">;
  /**
   * Where a review's draft is held for a teammate or queued for an automatic send, and where the
   * sweep dispatches queued sends or returns abandoned ones; called only while draining.
   */
  heldReplies: Pick<HeldReplyService, "hold" | "queueAuto" | "findByReviewRef" | "materializeAuto" | "returnAbandonedAuto">;
  /**
   * Hands a conversation to a person inside the caller's transaction: a review's hand-off, while
   * draining, and a mailbox policy change's hand-off of the conversations whose draft it superseded.
   */
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  /** Tells the dashboard of a hand-off once it commits. */
  publisher?: WorkspaceInvalidationPublisher;
  /**
   * The structured inference the review's model checks call: the reply triage before a turn and
   * the completeness check before an automatic send. Called only while draining.
   */
  reviewInference: EmailReviewInferenceFactory;
  agents: { findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ id: string } | null> };
  audit: Pick<AuditPort, "record">;
  /** Pushed once a resolution that queued a resend commits. */
  actionDrain: ActionDrainDispatcherPort;
  errorReporter?: Pick<ErrorReporter, "report">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
}

/**
 * Assembles the email channel: provider adapters, the webhook plugin, the inbound processor and
 * its worker and sweep, the send path's reconciler and provider-event processor, the settings
 * services and the reply deliverer. Null when no email provider is configured, so nothing of the
 * channel is mounted or started. The `email.send` handler is registered by
 * `createEmailChannelApplicationModule`, because the outbox worker is built before the channel.
 */
export const createEmailChannelComposition = (input: EmailChannelCompositionInput): EmailChannelComposition | null => {
  const { config, db, metrics, logger } = input;
  if (!config) {
    return null;
  }
  const options = input.options ?? {};
  const provider = channelProviderOf(config, options);
  const clock = () => new Date();
  const randomBytesOf = (size: number): Uint8Array => randomBytes(size);
  const { receiver, provisioner } = providerAdapters(config, provider);
  const sends = createEmailSendServices({
    provider,
    db,
    activity: input.activity,
    drains: input.drains,
    heldReplyDispatch: input.heldReplies,
    audit: input.audit,
    metrics,
    logger,
    clock,
  });

  const domainRecords = new EmailDomainRepository(db);
  const mailboxRecords = new EmailMailboxRepository(db);
  const inbound = new EmailInboundRepository(db);
  const threads = new EmailThreadRepository(db);
  const policyChanges = createPostgresMailboxPolicyChangeUnitOfWork({ db, activity: input.activity, ownership: input.ownership, publisher: input.publisher });
  const heldReplyRecords = new HeldReplyRepository(db);
  const ownership = new ConversationOwnershipRepository(db);
  const ownershipVersions = { versionOf: async (conversationId: string) => (await ownership.load(conversationId))?.version ?? 0 };
  const humanOwned = async (conversationId: string) => (await ownership.load(conversationId))?.state === "human_owned";
  const sendingDomains = new SendingDomainService({
    domains: domainRecords,
    mailboxes: mailboxRecords,
    provisioner,
    metrics,
    clock,
    inboundDomain: config.inboundDomain,
    audit: input.audit,
    logger,
  });
  const mailboxes = new MailboxService({
    mailboxes: mailboxRecords,
    domainRecords,
    sendingDomains,
    policyChanges,
    agents: input.agents,
    randomBytes: randomBytesOf,
    clock,
    config: { inboundDomain: config.inboundDomain, supportedModes: SUPPORTED_MODES },
    audit: input.audit,
    logger,
  });

  const messages = new MessageRepository(db);
  const chunkPassages = new ChunkPassageRepository(db);
  const reviewChecks = createEmailReviewChecks({
    inference: input.reviewInference,
    transcript: {
      recentMessages: async ({ workspaceId, conversationId, limit }) =>
        transcriptOf(await messages.listRecentByConversationId(workspaceId, conversationId, limit)),
    },
    grounding: {
      passagesFor: async ({ workspaceId, draft }) =>
        (await chunkPassages.findPassages(workspaceId, reviewDraftRetrievedChunkIds(draft))).map((passage) => ({ title: passage.title, text: passage.content })),
    },
    metrics,
    logger,
  });

  const connector = createEmailChannelConnector({
    receiver,
    inbound,
    mailboxes: mailboxRecords,
    domains: domainRecords,
    threads,
    receipts: mailboxes,
    deliveryEvents: sends.deliveryEvents,
    threadProtocol: createPostgresThreadProtocolUnitOfWork({ db, activity: input.activity }),
    chat: input.chat,
    review: {
      conversations: {
        latestCustomerMessageId: (conversationId) => heldReplyRecords.latestCustomerMessageId(conversationId),
        ownershipVersionOf: ownershipVersions.versionOf,
        humanOwned,
      },
      heldReplies: {
        hold: (hold) => input.heldReplies.hold(hold),
        queueAuto: (queued) => input.heldReplies.queueAuto(queued),
        findByReviewRef: (conversationId, reviewRef) => input.heldReplies.findByReviewRef(conversationId, reviewRef),
        supersedePendingForConversation: (conversationId, reason) => heldReplyRecords.supersedePendingForConversation(conversationId, reason),
      },
      handoffs: createPostgresReviewHandoffs({ db, activity: input.activity, ownership: input.ownership, publisher: input.publisher }),
      checks: reviewChecks,
      notes: createPostgresReviewNotes({ db, inbound, activity: input.activity }),
      maxAttempts: options.reviewMaxAttempts ?? EMAIL_REVIEW_MAX_ATTEMPTS,
    },
    drains: input.drains,
    metrics,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: randomBytesOf,
    config: {
      inboundDomain: config.inboundDomain,
      rawMaxBytes: options.rawMaxBytes ?? EMAIL_RAW_MAX_BYTES,
      supportedModes: SUPPORTED_MODES,
      coalesceSeconds: options.coalesceSeconds ?? EMAIL_COALESCE_SECONDS,
    },
    workersEnabled: config.workersEnabled,
    sweep: new EmailChannelSweep({
      inbound,
      domains: sendingDomains,
      sends: sends.reconciler,
      clock,
      logger,
      config: { eventRetentionDays: options.eventRetentionDays ?? EMAIL_EVENT_RETENTION_DAYS },
      abandonedAutoSends: {
        queued: heldReplyRecords,
        outbox: new ActionRequestRepository(db),
        dispatch: { returnAbandonedAuto: (heldReplyId) => input.heldReplies.returnAbandonedAuto(heldReplyId) },
      },
      queuedAutoRollback: SUPPORTED_MODES.includes("auto")
        ? undefined
        : { queued: heldReplyRecords, dispatch: { materializeAuto: (heldReplyId) => input.heldReplies.materializeAuto(heldReplyId) } },
    }),
  });

  const eventLog = new EventLogReader({ mailboxes: mailboxRecords, deliveries: inbound, clock });
  const conversationFacts = new ConversationEmailFactsReader({
    threads,
    mailboxes: mailboxRecords,
    domains: domainRecords,
    sends: sends.intents,
  });

  return {
    supportedModes: SUPPORTED_MODES,
    receiver,
    provisioner,
    plugin: connector.plugin,
    worker: connector.worker,
    customerReplyDeliverer: new EmailCustomerReplyDeliverer({
      mailboxes: mailboxRecords,
      domains: domainRecords,
      ownership: ownershipVersions,
    }),
    policyChanges,
    reviewChecks,
    inboundDomain: config.inboundDomain,
    sendingDomains,
    mailboxes,
    eventLog,
    inboundEvents: new InboundEventActions({
      deliveries: inbound,
      mailboxes: mailboxRecords,
      events: eventLog,
      drains: input.drains,
      metrics,
      inboundDomain: config.inboundDomain,
      audit: input.audit,
      logger,
    }),
    conversationFacts,
    copilotView: new EmailChannelCopilotView({
      mailboxes: mailboxRecords,
      domains: domainRecords,
      events: eventLog,
      facts: conversationFacts,
      supportedModes: SUPPORTED_MODES,
      clock,
    }),
    heldReplyChannel: createEmailHeldReplyChannelRegistration({ provider: config.provider.kind }),
    deliveryFailureResolver: new EmailDeliveryFailureResolver({
      intents: sends.intents,
      mailboxes: mailboxRecords,
      domains: domainRecords,
      ownership: ownershipVersions,
      unitOfWork: createPostgresDeliveryResolutionUnitOfWork({
        db,
        activity: input.activity,
        actionDrain: input.actionDrain,
        errorReporter: input.errorReporter,
        logger,
      }),
      metrics,
    }),
  };
};

/**
 * Registers the `email.send` outbox handler when the email channel is configured (research B6).
 * Host code alone queues sends, in the transaction that writes what they deliver, so routines
 * never emit one. The worker builds the handler with its own database, metrics and audit sink.
 */
export const createEmailChannelApplicationModule = (input: {
  config: EmailChannelConfig | undefined;
  options?: EmailChannelOptions;
  drainDispatcherFor: (env: Env, config: EmailChannelConfig) => EmailChannelDrainDispatcherPort;
}): ApplicationModule => ({
  id: "radioso-email-channel",
  name: "Radioso Email Channel",
  register(context) {
    const { config } = input;
    if (!config) return;
    context.registerActionHandler({
      type: EMAIL_SEND_ACTION_TYPE,
      // Host code queues every send in its own transaction: the operator reply deliverer, a
      // held-reply release, or an auto reply. Neither routine authoring nor a chat turn admits it.
      queuedFrom: "outside_turn",
      handler: ({ database, env, logger, auditService, metrics, errorReporter }) => {
        const db = database.kysely;
        const activity = new ConversationActivityRepository(db);
        return createEmailSendServices({
          provider: channelProviderOf(config, input.options ?? {}),
          db,
          activity,
          drains: input.drainDispatcherFor(env, config),
          heldReplyDispatch: createHeldReplyDispatch({ config, db, activity, audit: auditService, metrics: metrics ?? null, logger, errorReporter }),
          audit: auditService,
          metrics: metrics ?? null,
          logger,
          clock: () => new Date(),
        }).handler;
      },
    });
  },
});

/**
 * Email's side of held-reply transactions (research B1, B9): drafts bound to a mailbox's policy,
 * locked and sent through the transaction's repositories. Automatic sending is granted only where
 * the deployment runs `auto`: the thread's send budget, the queued send, its authorization at
 * dispatch, and the send intent a materialization records.
 */
export const createEmailHeldReplyChannelRegistration = (input: { provider: string }): HeldReplyChannelRegistration => ({
  policyRefPrefix: EMAIL_MAILBOX_POLICY_REF_PREFIX,
  bind: (trx) => new EmailHeldReplyChannelScope({
    mailboxes: new EmailMailboxRepository(trx),
    domains: new EmailDomainRepository(trx),
    autoSend: SUPPORTED_MODES.includes("auto")
      ? {
          threads: new EmailThreadRepository(trx),
          ownership: new ConversationOwnershipRepository(trx),
          intents: new EmailSendIntentRepository(trx),
          provider: input.provider,
          createId: randomUUID,
        }
      : undefined,
  }),
});

/**
 * The held-reply dispatch port the worker's `email.send` handler materializes automatic replies
 * through (research B9), over Postgres. The handler is built before the application's held-reply
 * service, so it gets its own. Materializing writes the agent's message and its send intent and
 * queues nothing, so the teammate-facing ports a release needs are refused, and no drain is pushed.
 */
const createHeldReplyDispatch = (deps: {
  config: EmailChannelConfig;
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  audit: Pick<AuditPort, "record">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
  errorReporter?: Pick<ErrorReporter, "report">;
}): Pick<HeldReplyDispatchPort, "materializeAuto"> => {
  const notOnTheDispatchPath = (): never => {
    throw new Error("held_reply_dispatch_releases_nothing");
  };
  const service = new HeldReplyService({
    conversations: new ConversationRepository(deps.db),
    writes: createPostgresHeldReplyUnitOfWork({
      db: deps.db,
      channels: [createEmailHeldReplyChannelRegistration({ provider: deps.config.provider.kind })],
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
    metrics: deps.metrics,
    logger: deps.logger,
    errorReporter: deps.errorReporter,
  });
  return { materializeAuto: (heldReplyId) => service.materializeAuto(heldReplyId) };
};

/**
 * The send path (research B6, B18): the action handler, the reconciler and the provider-event
 * processor, sharing one channel driver and one fenced writer whose unit of work binds the
 * transition, its delivery failure and its thread index rows to one transaction.
 */
const createEmailSendServices = (input: {
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
      messages: new MessageRepository(db),
      mailboxes,
      domains,
      threads: new EmailThreadRepository(db),
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

/** The channel's sending driver, separate from transactional mail's (quickstart §1). */
const channelEmailDriver = (provider: ChannelProvider): EmailDriver =>
  provider.kind === "resend"
    ? new ResendEmailDriver({ api: new ResendApiClient({ apiKey: provider.apiKey }) })
    : new LocalEmailDriver({ spoolDir: provider.spoolDir });

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

/**
 * Delivery failures over Postgres: each change commits with the activity it records, and the reads
 * serve the operator surfaces. Channel-neutral; the send path binds its own recorder to the
 * transition's transaction instead.
 */
export const createPostgresDeliveryFailures = (deps: { db: Kysely<DB>; activity: ConversationActivityRecorder }): DeliveryFailures => {
  const writes: DeliveryFailureUnitOfWork = {
    run: (work) => deps.db.transaction().execute((trx) => work({
      failures: new ConversationDeliveryFailureRepository(trx),
      activity: { record: (event) => deps.activity.record(trx, event) },
    })),
  };
  return new DeliveryFailures({ writes, reads: new ConversationDeliveryFailureRepository(deps.db) });
};

const providerAdapters = (
  config: EmailChannelConfig,
  provider: ChannelProvider,
): { receiver: InboundEmailReceiver; provisioner: EmailDomainProvisioner } => {
  const signingSecrets = { current: config.webhookSecret, previous: config.previousWebhookSecret ?? null };
  if (provider.kind === "resend") {
    const api = new ResendApiClient({ apiKey: provider.apiKey });
    return {
      receiver: new ResendInboundEmailReceiver({ api, signingSecrets }),
      provisioner: new ResendEmailDomainProvisioner({ api, region: provider.region, resolveTxt: (hostname) => resolveTxt(hostname) }),
    };
  }
  return {
    receiver: new LocalInboundEmailReceiver({ spoolDir: provider.spoolDir, signingSecrets }),
    provisioner: new LocalEmailDomainProvisioner({ spoolDir: provider.spoolDir }),
  };
};

/**
 * Binds one step of the thread protocol (research B15) to one Postgres transaction: the
 * resolution lock, the reservation log, the thread index, the conversation reads and the
 * activity it records. Only binds; what is read and written is the processor's decision.
 */
export const createPostgresThreadProtocolUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
}): EmailThreadProtocolUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({
    lockThread: (input) => lockThreadResolution(trx, input),
    inbound: new EmailInboundRepository(trx),
    threads: new EmailThreadRepository(trx),
    conversations: { ownershipOf: (input) => conversationOwnershipOf(trx, input) },
    activity: { record: (event) => deps.activity.record(trx, event) },
  })),
});

/**
 * A review's hand-off to a person (research B3, B7) in its own Postgres transaction: the ownership
 * change with the activity it records, through the ownership rules, and the dashboard told once it
 * commits. Only binds; whether to hand off is the review runner's decision.
 */
/** The conversation as the review's model checks read it: the customer's messages and the business's, never a system row. */
const transcriptOf = (records: readonly MessageRecord[]): EmailTranscriptMessage[] =>
  records.flatMap((record) => {
    if (record.role === "system") return [];
    return [{ author: record.role === "user" ? "customer" as const : "business" as const, text: record.content }];
  });

/** A review's note on the thread: a `channel_exception` naming why the customer's newest email was set aside. */
const createPostgresReviewNotes = (deps: {
  db: Kysely<DB>;
  inbound: Pick<EmailInboundRepository, "findDeliveryIdForMessage">;
  activity: ConversationActivityRecorder;
}) => ({
  async recordSetAside(input: { workspaceId: string; conversationId: string; messageId: string; code: string }): Promise<void> {
    const deliveryId = await deps.inbound.findDeliveryIdForMessage(input.conversationId, input.messageId);
    if (!deliveryId) throw new Error("email_review_note_without_delivery");
    await deps.activity.record(deps.db, {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      kind: "channel_exception",
      actorUserId: null,
      detail: { code: input.code, deliveryId },
    });
  },
});

const createPostgresReviewHandoffs = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  publisher?: WorkspaceInvalidationPublisher;
}) => ({
  async requestHumanOwnership(input: { workspaceId: string; conversationId: string; reason: string }): Promise<void> {
    const { changed } = await deps.db.transaction().execute((trx) => deps.ownership.requestHumanOwnership({
      ownership: new ConversationOwnershipRepository(trx),
      activity: { record: (event) => deps.activity.record(trx, event) },
    }, input));
    if (changed && deps.publisher) {
      flushPostCommitInvalidationReceipt(
        deps.publisher,
        createPostCommitInvalidationReceipt(input.workspaceId, ["conversation.ownership_changed"]),
      );
    }
  },
});

/** Null while the conversation does not exist yet; a conversation with no ownership row is the AI's. */
const conversationOwnershipOf = async (
  db: Db,
  input: { conversationId: string; workspaceId: string },
): Promise<"ai_owned" | "human_owned" | null> => {
  const conversation = await new ConversationRepository(db).findByIdAndWorkspaceId(input.conversationId, input.workspaceId);
  if (!conversation) {
    return null;
  }
  const ownership = await new ConversationOwnershipRepository(db).load(input.conversationId);
  return ownership?.state ?? "ai_owned";
};
