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
import { ConversationActivityRepository } from "../../db/repositories/conversationActivityRepository.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../db/repositories/messageRepository.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import type { ActionDrainDispatcherPort } from "../../modules/chat/composition.js";
import {
  createEmailChannelConnector,
  type EmailChannelWorker,
  type EmailThreadProtocolUnitOfWork,
} from "../../modules/connectors/plugins/index.js";
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
  EMAIL_SEND_ACTION_TYPE,
  EmailChannelCopilotView,
  EmailChannelSweep,
  EmailCustomerReplyDeliverer,
  EmailDeliveryFailureResolver,
  EmailDomainRepository,
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
import type { ConversationOwnershipService, HeldReplyService } from "../../modules/handoff/public.js";
import { LocalEmailDomainProvisioner } from "../../modules/mail/adapters/localDomainProvisioner.js";
import { LocalEmailDriver } from "../../modules/mail/adapters/localEmailDriver.js";
import { LocalInboundEmailReceiver } from "../../modules/mail/adapters/localInboundReceiver.js";
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
import { createPostgresMailboxPolicyChangeUnitOfWork } from "./mailboxPolicyChange.js";

type EmailChannelConfig = NonNullable<ReturnType<typeof parseEmailChannelConfig>>;

/**
 * The engagement modes this deployment runs (plan, Questions settled, item 4): mail is handed to
 * people, or the agent drafts a reply a teammate sends. `draft` is the default for new mailboxes;
 * existing ones keep their mode. Automatic sending arrives with `auto`, which widens it.
 */
const SUPPORTED_MODES: readonly EngagementMode[] = ["operator_only", "draft"];

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
  /** The email half of a teammate's decision on a failed reply: mark it sent, or resend it. */
  deliveryFailureResolver: DeliveryFailureResolverPort;
}

interface EmailChannelCompositionInput {
  /** `parseEmailChannelConfig(env)`; undefined when no email provider is configured. */
  config: EmailChannelConfig | undefined;
  db: Kysely<DB>;
  drains: EmailChannelDrainDispatcherPort;
  activity: ConversationActivityRecorder;
  /**
   * The host port: `ingest` records inbound mail, `respond` runs its review turn. Called only while
   * draining, after the application is built.
   */
  chat: Pick<ConnectorChatPort, "ingest" | "respond">;
  /** Where a review's draft is held for a teammate; called only while draining. */
  heldReplies: Pick<HeldReplyService, "hold" | "findByReviewRef">;
  /** Hands a reviewed conversation to a person inside the review's hand-off transaction; called only while draining. */
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  /** Tells the dashboard of a hand-off once it commits. */
  publisher?: WorkspaceInvalidationPublisher;
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
  const clock = () => new Date();
  const randomBytesOf = (size: number): Uint8Array => randomBytes(size);
  const { receiver, provisioner } = providerAdapters(config);
  const sends = createEmailSendServices({ config, db, activity: input.activity, drains: input.drains, audit: input.audit, metrics, logger, clock });

  const domainRecords = new EmailDomainRepository(db);
  const mailboxRecords = new EmailMailboxRepository(db);
  const inbound = new EmailInboundRepository(db);
  const threads = new EmailThreadRepository(db);
  const policyChanges = createPostgresMailboxPolicyChangeUnitOfWork({ db });
  const heldReplyRecords = new HeldReplyRepository(db);
  const ownership = new ConversationOwnershipRepository(db);
  const ownershipVersions = { versionOf: async (conversationId: string) => (await ownership.load(conversationId))?.version ?? 0 };
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
      },
      heldReplies: {
        hold: (hold) => input.heldReplies.hold(hold),
        findByReviewRef: (conversationId, reviewRef) => input.heldReplies.findByReviewRef(conversationId, reviewRef),
        supersedePendingForConversation: (conversationId, reason) => heldReplyRecords.supersedePendingForConversation(conversationId, reason),
      },
      handoffs: createPostgresReviewHandoffs({ db, activity: input.activity, ownership: input.ownership, publisher: input.publisher }),
      maxAttempts: config.reviewMaxAttempts,
    },
    drains: input.drains,
    metrics,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: randomBytesOf,
    config: {
      inboundDomain: config.inboundDomain,
      rawMaxBytes: config.rawMaxBytes,
      supportedModes: SUPPORTED_MODES,
      coalesceSeconds: config.coalesceSeconds,
    },
    workersEnabled: config.workersEnabled,
    sweep: new EmailChannelSweep({
      inbound,
      domains: sendingDomains,
      sends: sends.reconciler,
      clock,
      logger,
      config: { eventRetentionDays: config.eventRetentionDays },
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
  drainDispatcherFor: (env: Env, config: EmailChannelConfig) => EmailChannelDrainDispatcherPort;
}): ApplicationModule => ({
  id: "radioso-email-channel",
  name: "Radioso Email Channel",
  register(context) {
    const { config } = input;
    if (!config) return;
    context.registerActionHandler({
      type: EMAIL_SEND_ACTION_TYPE,
      emittableByRoutines: false,
      handler: ({ database, env, logger, auditService, metrics }) =>
        createEmailSendServices({
          config,
          db: database.kysely,
          activity: new ConversationActivityRepository(database.kysely),
          drains: input.drainDispatcherFor(env, config),
          audit: auditService,
          metrics: metrics ?? null,
          logger,
          clock: () => new Date(),
        }).handler,
    });
  },
});

/**
 * The send path (research B6, B18): the action handler, the reconciler and the provider-event
 * processor, sharing one channel driver and one fenced writer whose unit of work binds the
 * transition, its delivery failure and its thread index rows to one transaction.
 */
const createEmailSendServices = (input: {
  config: EmailChannelConfig;
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  drains: EmailChannelDrainDispatcherPort;
  audit: Pick<AuditPort, "record">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
  clock: () => Date;
}) => {
  const { config, db, metrics, logger, clock } = input;
  const driver = channelEmailDriver(config);
  const intents = new EmailSendIntentRepository(db);
  const mailboxes = new EmailMailboxRepository(db);
  const domains = new EmailDomainRepository(db);
  const unitOfWork = createPostgresEmailSendUnitOfWork({ db, activity: input.activity });
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
      attempt,
      writer,
      failures: createPostgresDeliveryFailures({ db, activity: input.activity }),
      provider: config.provider.kind,
      metrics,
      logger,
      createId: randomUUID,
    }),
    reconciler: new SendReconciler({ intents, mailboxes, domains, driver, attempt, writer, metrics, logger }),
    deliveryEvents: new ProviderDeliveryEvents({ intents, writer, audit: input.audit, metrics, logger }),
  };
};

/** The channel's sending driver, separate from transactional mail's (quickstart §1). */
const channelEmailDriver = (config: EmailChannelConfig): EmailDriver =>
  config.provider.kind === "resend"
    ? new ResendEmailDriver({ api: new ResendApiClient({ apiKey: config.provider.apiKey }) })
    : new LocalEmailDriver({ spoolDir: config.provider.spoolDir });

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

const providerAdapters = (config: EmailChannelConfig): { receiver: InboundEmailReceiver; provisioner: EmailDomainProvisioner } => {
  const signingSecrets = { current: config.webhookSecret, previous: config.previousWebhookSecret ?? null };
  if (config.provider.kind === "resend") {
    const api = new ResendApiClient({ apiKey: config.provider.apiKey });
    return {
      receiver: new ResendInboundEmailReceiver({ api, signingSecrets }),
      provisioner: new ResendEmailDomainProvisioner({ api, region: config.provider.region, resolveTxt: (hostname) => resolveTxt(hostname) }),
    };
  }
  return {
    receiver: new LocalInboundEmailReceiver({ spoolDir: config.provider.spoolDir, signingSecrets }),
    provisioner: new LocalEmailDomainProvisioner({ spoolDir: config.provider.spoolDir }),
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
