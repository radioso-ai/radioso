import type { DnsRecordView } from "../../mail/public.js";
import { sendingStateOf, type MailboxSendingState } from "../domains/sendingState.js";
import type { EventLogReader } from "../eventLog/eventLogReader.js";
import type { ConversationEmailFacts, ConversationEmailFactsReader } from "../facts/conversationEmailFacts.js";
import type { EngagementMode } from "../mailboxes/effectiveMode.js";
import { defaultEngagementMode } from "../mailboxes/mailboxService.js";
import { deriveReceivingState } from "../mailboxes/receivingState.js";
import type { DomainReceivingStatus, DomainSendingStatus, EmailDomainRecord, EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";

// Every projection below picks its fields one by one at runtime (NB-2). Never spread a record
// into one: relay tokens, setup-check recipients, thread tokens, raw content and any address
// other than the mailbox's own must not reach Ray.

interface EmailMailboxCopilotView {
  id: string;
  address: string;
  agentId: string | null;
  engagementMode: EngagementMode;
  enabled: boolean;
  receivingState: ReturnType<typeof deriveReceivingState>;
  lastReceivedAt: string | null;
  sendingState: MailboxSendingState;
  threadSendBudget: number;
  hourlyGenerationBudget: number;
}

interface EmailDomainCopilotView {
  id: string;
  domain: string;
  sendingStatus: DomainSendingStatus;
  receivingStatus: DomainReceivingStatus;
  records: Pick<DnsRecordView, "purpose" | "type" | "name" | "status">[];
}

interface EmailEventLogCopilotSummary {
  mailboxId: string;
  window: string;
  byDisposition: Record<string, number>;
  failed: number;
  lastReceivedAt: string | null;
}

interface EmailConversationCopilotFacts {
  mailbox: { id: string; address: string; displayName: string; engagementMode: EngagementMode };
  participant: { displayName: string | null };
  latest: { subject: string | null; ccCount: number; inboundAt: string | null };
  sending: { state: MailboxSendingState };
  sendBudget: { used: number; limit: number; renewedAt: string | null };
  messages: {
    messageId: string;
    direction: "inbound" | "outbound";
    subject: string | null;
    ccCount: number;
    attachments: { name: string; contentType: string; sizeBytes: number }[];
    hasRaw: boolean;
  }[];
}

const toDomainView = (domain: EmailDomainRecord): EmailDomainCopilotView => ({
  id: domain.id,
  domain: domain.domain,
  sendingStatus: domain.sendingStatus,
  receivingStatus: domain.receivingStatus,
  records: domain.dnsRecords.map((record) => ({ purpose: record.purpose, type: record.type, name: record.name, status: record.status })),
});

const toFactsView = (facts: ConversationEmailFacts): EmailConversationCopilotFacts => ({
  mailbox: {
    id: facts.mailbox.id,
    address: facts.mailbox.address,
    displayName: facts.mailbox.displayName,
    engagementMode: facts.mailbox.engagementMode,
  },
  participant: { displayName: facts.participant.displayName },
  latest: { subject: facts.latest.subject, ccCount: facts.latest.cc.length, inboundAt: facts.latest.inboundAt },
  sending: { state: facts.sending.state },
  sendBudget: { used: facts.sendBudget.used, limit: facts.sendBudget.limit, renewedAt: facts.sendBudget.renewedAt },
  messages: facts.messages.map((message) => ({
    messageId: message.messageId,
    direction: message.direction,
    subject: message.subject,
    ccCount: message.cc.length,
    attachments: message.attachments.map((attachment) => ({
      name: attachment.name,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    })),
    hasRaw: message.rawDeliveryId !== null,
  })),
});

/** The token-free, read-only projection Ray's email channel tools are built on (ports §8). */
export class EmailChannelCopilotView {
  constructor(private readonly deps: {
    mailboxes: Pick<EmailMailboxRepository, "listActive">;
    domains: Pick<EmailDomainRepository, "listActive" | "findById">;
    events: Pick<EventLogReader, "summarize">;
    facts: Pick<ConversationEmailFactsReader, "read">;
    supportedModes: readonly EngagementMode[];
    clock: () => Date;
  }) {}

  async configuration(workspaceId: string): Promise<{
    supportedModes: EngagementMode[];
    defaultMode: EngagementMode;
    domains: EmailDomainCopilotView[];
    mailboxes: EmailMailboxCopilotView[];
  }> {
    const [domains, mailboxes] = await Promise.all([
      this.deps.domains.listActive(workspaceId),
      this.deps.mailboxes.listActive(workspaceId),
    ]);
    const domainsById = new Map(domains.map((domain) => [domain.id, domain]));
    return {
      supportedModes: [...this.deps.supportedModes],
      defaultMode: defaultEngagementMode(this.deps.supportedModes),
      domains: domains.map(toDomainView),
      mailboxes: await Promise.all(mailboxes.map(async (mailbox) =>
        this.toMailboxView(mailbox, domainsById.get(mailbox.domainId) ?? (await this.deps.domains.findById(mailbox.domainId))))),
    };
  }

  /** Event log summaries over the last `windowHours`, for one mailbox or every active one. */
  async eventSummaries(
    workspaceId: string,
    query: { mailboxId: string | null; windowHours: number },
  ): Promise<{ summaries: EmailEventLogCopilotSummary[] }> {
    const mailboxIds = query.mailboxId
      ? [query.mailboxId]
      : (await this.deps.mailboxes.listActive(workspaceId)).map((mailbox) => mailbox.id);
    const summaries = await Promise.all(mailboxIds.map((mailboxId) => this.deps.events.summarize(workspaceId, mailboxId, query.windowHours)));
    return {
      summaries: summaries.map((summary) => ({
        mailboxId: summary.mailboxId,
        window: summary.window,
        byDisposition: { ...summary.byDisposition },
        failed: summary.failed,
        lastReceivedAt: summary.lastReceivedAt,
      })),
    };
  }

  async conversationFacts(workspaceId: string, conversationId: string): Promise<{ facts: EmailConversationCopilotFacts | null }> {
    const facts = await this.deps.facts.read(workspaceId, conversationId);
    return { facts: facts ? toFactsView(facts) : null };
  }

  private toMailboxView(mailbox: EmailMailboxRecord, domain: EmailDomainRecord | null): EmailMailboxCopilotView {
    return {
      id: mailbox.id,
      address: mailbox.address,
      agentId: mailbox.agentId,
      engagementMode: mailbox.engagementMode,
      enabled: mailbox.enabled,
      receivingState: deriveReceivingState({
        lastReceivedAt: mailbox.lastReceivedAt,
        silenceThresholdHours: mailbox.silenceThresholdHours,
        now: this.deps.clock(),
      }),
      lastReceivedAt: mailbox.lastReceivedAt?.toISOString() ?? null,
      sendingState: sendingStateOf(domain),
      threadSendBudget: mailbox.threadSendBudget,
      hourlyGenerationBudget: mailbox.hourlyGenerationBudget,
    };
  }
}
