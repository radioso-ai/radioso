import type { AuditPort } from "../../../modules/audit/contracts/index.js";
import {
  ConversationEmailFactsReader,
  EmailChannelCopilotView,
  EventLogReader,
  InboundEventActions,
  MailboxService,
  SendingDomainService,
  type EmailChannelDrainDispatcherPort,
  type EmailDomainRepository,
  type EmailInboundRepository,
  type EmailMailboxRepository,
  type EmailSendIntentRepository,
  type EmailThreadRepository,
  type EngagementMode,
  type MailboxPolicyChangeUnitOfWork,
} from "../../../modules/emailChannel/public.js";
import type { EmailDomainProvisioner } from "../../../modules/mail/public.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

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

/** The operator services, and the token-free projection of them Ray's email channel tools read (ports §8). */
export const createEmailChannelOperatorServices = (deps: {
  domains: EmailDomainRepository;
  mailboxes: EmailMailboxRepository;
  inbound: EmailInboundRepository;
  threads: EmailThreadRepository;
  sends: EmailSendIntentRepository;
  provisioner: EmailDomainProvisioner;
  policyChanges: MailboxPolicyChangeUnitOfWork;
  drains: EmailChannelDrainDispatcherPort;
  agents: { findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<{ id: string } | null> };
  audit: Pick<AuditPort, "record">;
  inboundDomain: string;
  supportedModes: readonly EngagementMode[];
  randomBytes: (size: number) => Uint8Array;
  clock: () => Date;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
}): EmailChannelOperatorServices & { copilotView: EmailChannelCopilotView } => {
  const { inboundDomain, supportedModes, audit, metrics, logger, clock } = deps;
  const sendingDomains = new SendingDomainService({
    domains: deps.domains,
    mailboxes: deps.mailboxes,
    provisioner: deps.provisioner,
    metrics,
    clock,
    inboundDomain,
    audit,
    logger,
  });
  const mailboxes = new MailboxService({
    mailboxes: deps.mailboxes,
    domainRecords: deps.domains,
    sendingDomains,
    policyChanges: deps.policyChanges,
    agents: deps.agents,
    randomBytes: deps.randomBytes,
    clock,
    config: { inboundDomain, supportedModes },
    audit,
    logger,
  });
  const eventLog = new EventLogReader({ mailboxes: deps.mailboxes, deliveries: deps.inbound, clock });
  const conversationFacts = new ConversationEmailFactsReader({
    threads: deps.threads,
    mailboxes: deps.mailboxes,
    domains: deps.domains,
    sends: deps.sends,
  });
  return {
    inboundDomain,
    sendingDomains,
    mailboxes,
    eventLog,
    inboundEvents: new InboundEventActions({
      deliveries: deps.inbound,
      mailboxes: deps.mailboxes,
      events: eventLog,
      drains: deps.drains,
      metrics,
      inboundDomain,
      audit,
      logger,
    }),
    conversationFacts,
    copilotView: new EmailChannelCopilotView({
      mailboxes: deps.mailboxes,
      domains: deps.domains,
      events: eventLog,
      facts: conversationFacts,
      supportedModes,
      clock,
    }),
  };
};
