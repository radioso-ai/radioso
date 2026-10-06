import { randomBytes, randomUUID } from "node:crypto";

import type { ConnectorChatPort, ConnectorPlugin } from "@radioso/connector-api";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import type { Kysely } from "kysely";

import type { Env } from "../../config/env.js";
import { ConversationActivityRepository } from "../../../db/repositories/conversationActivityRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import type { ActionDrainDispatcherPort } from "../../../modules/chat/composition.js";
import {
  EMAIL_COALESCE_SECONDS,
  EMAIL_RAW_MAX_BYTES,
  EMAIL_REVIEW_MAX_ATTEMPTS,
  createEmailChannelConnector,
  type EmailChannelWorker,
  type EmailReviewChecks,
  type EmailReviewInferenceFactory,
} from "../../../modules/connectors/plugins/index.js";
import type { ConversationActivityRecorder } from "../../../modules/conversationActivity/contracts/index.js";
import type { CustomerChannelReplyDeliverer, DeliveryFailureResolverPort } from "../../../modules/customerReplyDelivery/public.js";
import {
  EMAIL_EVENT_RETENTION_DAYS,
  EMAIL_SEND_ACTION_TYPE,
  EmailCustomerReplyDeliverer,
  EmailDomainRepository,
  EmailInboundRepository,
  EmailMailboxRepository,
  EmailThreadRepository,
  type EmailChannelCopilotView,
  type EmailChannelDrainDispatcherPort,
  type EngagementMode,
  type MailboxPolicyChangeUnitOfWork,
} from "../../../modules/emailChannel/public.js";
import { ownershipVersionOf, type ConversationOwnershipService, type HeldReplyService } from "../../../modules/handoff/public.js";
import type { EmailDomainProvisioner, InboundEmailReceiver } from "../../../modules/mail/public.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ApplicationModule } from "../applicationModule.js";
import type { HeldReplyChannelRegistration } from "../heldReplyUnitOfWork.js";
import { createPostgresMailboxPolicyChangeUnitOfWork } from "../mailboxPolicyChange.js";
import { channelProviderOf, providerAdapters, type EmailChannelConfig } from "./adapters.js";
import { createEmailChannelSweepOverPostgres, createPostgresThreadProtocolUnitOfWork } from "./inbound.js";
import { createEmailChannelOperatorServices, type EmailChannelOperatorServices } from "./operator.js";
import { createEmailDeliveryFailureResolver, createEmailSendServices, createWorkerEmailSendHandler } from "./outbound.js";
import { createEmailHeldReplyChannelRegistration, createEmailReviewChecksOverPostgres, createEmailReviewPorts } from "./review.js";

export { createEmailHeldReplyChannelRegistration } from "./review.js";
export type { EmailChannelOperatorServices, EmailReviewChecks };

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

/**
 * The engagement modes this deployment runs (plan, Questions settled, item 4): mail is handed to
 * people, the agent drafts a reply a teammate sends, or, on a mailbox an operator opted in, the
 * agent answers automatically when the publication decision allows (research B9). `draft` is the
 * default for new mailboxes; existing ones keep their mode. Without `auto` here, automatic sending
 * is not granted to the held-reply scope and the sweep returns queued sends to a teammate.
 */
const SUPPORTED_MODES: readonly EngagementMode[] = ["operator_only", "draft", "auto"];
const AUTO_SEND = SUPPORTED_MODES.includes("auto");

/** Email's held-reply registration for this deployment: automatic sending granted where it runs `auto`. */
const heldReplyChannelFor = (config: EmailChannelConfig): HeldReplyChannelRegistration =>
  createEmailHeldReplyChannelRegistration(AUTO_SEND ? { autoSend: true, provider: config.provider.kind } : { autoSend: false });

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
  const provider = channelProviderOf(config, options.localSpoolDir);
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

  const domains = new EmailDomainRepository(db);
  const mailboxes = new EmailMailboxRepository(db);
  const inbound = new EmailInboundRepository(db);
  const threads = new EmailThreadRepository(db);
  const ownership = new ConversationOwnershipRepository(db);
  const ownershipVersions = { versionOf: async (conversationId: string) => ownershipVersionOf(await ownership.load(conversationId)) };
  const policyChanges = createPostgresMailboxPolicyChangeUnitOfWork({
    db,
    activity: input.activity,
    ownership: input.ownership,
    publisher: input.publisher,
    logger,
  });
  const operator = createEmailChannelOperatorServices({
    domains,
    mailboxes,
    inbound,
    threads,
    sends: sends.intents,
    provisioner,
    policyChanges,
    drains: input.drains,
    agents: input.agents,
    audit: input.audit,
    inboundDomain: config.inboundDomain,
    supportedModes: SUPPORTED_MODES,
    randomBytes: randomBytesOf,
    clock,
    metrics,
    logger,
  });
  const reviewChecks = createEmailReviewChecksOverPostgres({ db, inference: input.reviewInference, metrics, logger });

  const connector = createEmailChannelConnector({
    receiver,
    inbound,
    mailboxes,
    domains,
    threads,
    receipts: operator.mailboxes,
    deliveryEvents: sends.deliveryEvents,
    threadProtocol: createPostgresThreadProtocolUnitOfWork({ db, activity: input.activity }),
    chat: input.chat,
    review: createEmailReviewPorts({
      db,
      activity: input.activity,
      heldReplies: input.heldReplies,
      ownership: input.ownership,
      publisher: input.publisher,
      checks: reviewChecks,
      maxAttempts: options.reviewMaxAttempts ?? EMAIL_REVIEW_MAX_ATTEMPTS,
    }),
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
    sweep: createEmailChannelSweepOverPostgres({
      db,
      inbound,
      sendingDomains: operator.sendingDomains,
      reconciler: sends.reconciler,
      heldReplies: input.heldReplies,
      autoSend: AUTO_SEND,
      eventRetentionDays: options.eventRetentionDays ?? EMAIL_EVENT_RETENTION_DAYS,
      metrics,
      logger,
      clock,
    }),
  });

  return {
    ...operator,
    supportedModes: SUPPORTED_MODES,
    receiver,
    provisioner,
    plugin: connector.plugin,
    worker: connector.worker,
    customerReplyDeliverer: new EmailCustomerReplyDeliverer({ mailboxes, domains, ownership: ownershipVersions }),
    policyChanges,
    reviewChecks,
    heldReplyChannel: heldReplyChannelFor(config),
    deliveryFailureResolver: createEmailDeliveryFailureResolver({
      db,
      intents: sends.intents,
      mailboxes,
      domains,
      ownership: ownershipVersions,
      activity: input.activity,
      actionDrain: input.actionDrain,
      errorReporter: input.errorReporter,
      metrics,
      logger,
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
      handler: ({ database, env, logger, auditService, metrics, errorReporter, publisher }) => {
        const db = database.kysely;
        return createWorkerEmailSendHandler({
          provider: channelProviderOf(config, input.options?.localSpoolDir),
          heldReplyChannel: heldReplyChannelFor(config),
          db,
          activity: new ConversationActivityRepository(db),
          drains: input.drainDispatcherFor(env, config),
          audit: auditService,
          metrics: metrics ?? null,
          logger,
          errorReporter,
          publisher,
        });
      },
    });
  },
});
