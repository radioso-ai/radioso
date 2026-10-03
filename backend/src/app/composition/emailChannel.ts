import { randomBytes, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

import type { ConnectorChatPort, ConnectorPlugin } from "@radioso/connector-api";
import type { Kysely } from "kysely";

import type { parseEmailChannelConfig } from "../config/env.js";
import { ConversationOwnershipRepository } from "../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../db/repositories/conversationRepository.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import {
  createEmailChannelConnector,
  type EmailChannelWorker,
  type EmailThreadProtocolUnitOfWork,
} from "../../modules/connectors/plugins/index.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import type { CustomerChannelReplyDeliverer } from "../../modules/customerReplyDelivery/public.js";
import {
  EmailChannelSweep,
  EmailCustomerReplyDeliverer,
  EmailDomainRepository,
  EmailInboundRepository,
  EmailMailboxRepository,
  EmailThreadRepository,
  MailboxService,
  SendingDomainService,
  lockThreadResolution,
  type EmailChannelDrainDispatcherPort,
  type EngagementMode,
  type MailboxPolicyChangeUnitOfWork,
} from "../../modules/emailChannel/public.js";
import { LocalEmailDomainProvisioner } from "../../modules/mail/adapters/localDomainProvisioner.js";
import { LocalInboundEmailReceiver } from "../../modules/mail/adapters/localInboundReceiver.js";
import { ResendApiClient } from "../../modules/mail/adapters/resendApi.js";
import { ResendEmailDomainProvisioner } from "../../modules/mail/adapters/resendDomainProvisioner.js";
import { ResendInboundEmailReceiver } from "../../modules/mail/adapters/resendInboundReceiver.js";
import type { EmailDomainProvisioner, InboundEmailReceiver } from "../../modules/mail/public.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { createPostgresMailboxPolicyChangeUnitOfWork } from "./mailboxPolicyChange.js";

type EmailChannelConfig = NonNullable<ReturnType<typeof parseEmailChannelConfig>>;

/**
 * The engagement modes this deployment runs (plan, Questions settled, item 4). Inbound mail is
 * received and handed to people; review turns and sending arrive in later slices, which widen it.
 */
const SUPPORTED_MODES: readonly EngagementMode[] = ["operator_only"];

export interface EmailChannelComposition {
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
  sendingDomains: SendingDomainService;
  mailboxes: MailboxService;
}

interface EmailChannelCompositionInput {
  /** `parseEmailChannelConfig(env)`; undefined when no email provider is configured. */
  config: EmailChannelConfig | undefined;
  db: Kysely<DB>;
  drains: EmailChannelDrainDispatcherPort;
  activity: ConversationActivityRecorder;
  /** The host's ingest port; called only while draining, after the application is built. */
  conversationIngest: Pick<ConnectorChatPort, "ingest">;
  agents: { findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ id: string } | null> };
  audit: Pick<AuditPort, "record">;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
}

/**
 * Assembles the email channel: provider adapters, the webhook plugin, the inbound processor and
 * its worker and sweep, the settings services and the reply deliverer. Null when no email
 * provider is configured, so nothing of the channel is mounted or started.
 */
export const createEmailChannelComposition = (input: EmailChannelCompositionInput): EmailChannelComposition | null => {
  const { config, db, metrics, logger } = input;
  if (!config) {
    return null;
  }
  const clock = () => new Date();
  const randomBytesOf = (size: number): Uint8Array => randomBytes(size);
  const { receiver, provisioner } = providerAdapters(config);

  const domainRecords = new EmailDomainRepository(db);
  const mailboxRecords = new EmailMailboxRepository(db);
  const inbound = new EmailInboundRepository(db);
  const policyChanges = createPostgresMailboxPolicyChangeUnitOfWork({ db });
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
    threads: new EmailThreadRepository(db),
    receipts: mailboxes,
    threadProtocol: createPostgresThreadProtocolUnitOfWork({ db, activity: input.activity }),
    chat: input.conversationIngest,
    drains: input.drains,
    metrics,
    logger,
    clock,
    createId: randomUUID,
    randomBytes: randomBytesOf,
    config: { inboundDomain: config.inboundDomain, rawMaxBytes: config.rawMaxBytes, supportedModes: SUPPORTED_MODES },
    workersEnabled: config.workersEnabled,
    sweep: new EmailChannelSweep({
      inbound,
      domains: sendingDomains,
      clock,
      logger,
      config: { eventRetentionDays: config.eventRetentionDays },
    }),
  });

  return {
    supportedModes: SUPPORTED_MODES,
    receiver,
    provisioner,
    plugin: connector.plugin,
    worker: connector.worker,
    customerReplyDeliverer: new EmailCustomerReplyDeliverer(),
    policyChanges,
    sendingDomains,
    mailboxes,
  };
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
const createPostgresThreadProtocolUnitOfWork = (deps: {
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
